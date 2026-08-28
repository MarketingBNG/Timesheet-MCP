import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "./config.js";
import { currentUser } from "./context.js";
import { log } from "./logger.js";
import { ZohoError } from "./errors.js";
import { audit } from "./audit.js";
import { matchTask, type Scored } from "./match.js";
import {
  buildDrafts,
  groupByDay,
  parseOmiConversations,
  rollUp,
} from "./omi.js";
import {
  assertIsoDate,
  dateRange,
  hoursToHHMM,
} from "./format.js";
import {

  createTask,
  updateTask,
  listTaskStatuses,
  createTimeLog,
  updateTimeLog,
  fetchTaskLogs,
  callerIsIdentified,
  isOwnLog,
  deleteTimeLog,
  getPortalMeta,
  getTaskById,
  getTasks,
  listProjects,
  listTimeLogs,
  type Task,
  type TimeLog,
} from "./zoho.js";

/* ------------------------------------------------------------------ *
 * Result helpers
 * ------------------------------------------------------------------ */

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string, data?: unknown): ToolResult {
  const body = data === undefined ? text : `${text}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: "text", text: body }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Turns any thrown value into a readable message instead of a stack trace. */
function explain(err: unknown): string {
  // ZohoError doubles as the carrier for local validation failures, which did
  // not come from Zoho and should not claim to have.
  if (err instanceof ZohoError) {
    const prefix = err.status !== undefined ? "Zoho API error: " : "";
    return `${prefix}${err.toDisplay()}`;
  }
  if (err instanceof Error) {
    log.error(err.stack ?? err.message);
    return `Error: ${err.message}`;
  }
  return `Unexpected error: ${String(err)}`;
}

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(explain(err));
  }
}

function candidateView(c: Scored) {
  return {
    task_id: c.task.task_id,
    task_name: c.task.task_name,
    project_id: c.task.project_id,
    project_name: c.task.project_name,
    score: Number(c.score.toFixed(3)),
    why: c.reason,
  };
}

function taskView(t: Task) {
  return {
    task_id: t.task_id,
    task_name: t.task_name,
    project_id: t.project_id,
    project_name: t.project_name,
    status: t.status,
  };
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

/**
 * Builds a fully-configured MCP server. Called once for a stdio process, and
 * once per request by the HTTP transport, so no state may leak between calls.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "zoho-timesheet", version: "1.0.0" },
    {
      instructions:
        "Files Zoho Projects timesheet entries. Prefer calling get_my_tasks first and " +
        "passing the exact task_id to log_time. If log_time reports an ambiguous match, " +
        "ask the user which candidate they meant instead of picking one.",
    },
  );

  /* ---------------------------- list_projects ---------------------------- */

  server.registerTool(
    "list_projects",
    {
      title: "List Zoho projects",
      description:
        "List the projects visible to the signed-in Zoho account. Cheap; use this to " +
        "narrow get_my_tasks with project_name when the portal has many tasks.",
      inputSchema: {
        include_inactive: z
          .boolean()
          .default(false)
          .describe("Include archived/closed projects as well as active ones."),
      },
    },
    async ({ include_inactive }) =>
      guarded(async () => {
        const projects = await listProjects(!include_inactive);
        return ok(`${projects.length} project(s).`, projects);
      }),
  );

  /* ---------------------------- get_my_tasks ----------------------------- */

  server.registerTool(
    "get_my_tasks",
    {
      title: "Get my Zoho tasks",
      description:
        "List tasks assigned to the signed-in Zoho user across all projects in the " +
        "portal, so a spoken task name can be resolved to a real task_id before logging time.",
      inputSchema: {
        project_name: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter on the project name."),
        include_completed: z
          .boolean()
          .default(false)
          .describe("Include closed/completed tasks. Off by default — you rarely log time to them."),
        include_others: z
          .boolean()
          .default(false)
          .describe(
            "Include tasks assigned to other people. Off by default; turning this on makes " +
              "name matching much riskier.",
          ),
        refresh: z
          .boolean()
          .default(false)
          .describe("Bypass the in-memory task cache and refetch from Zoho."),
      },
    },
    async ({ project_name, include_completed, include_others, refresh }) =>
      guarded(async () => {
        const tasks = await getTasks({
          projectName: project_name,
          openOnly: !include_completed,
          mineOnly: !include_others,
          forceRefresh: refresh,
        });

        if (tasks.length === 0) {
          const who = currentUser();
        const hint = include_others
            ? "No tasks matched those filters."
            : who
              ? `No open tasks are assigned to ${who.email || who.name} in Zoho. Ask for tasks ` +
                `to be assigned, create one with create_task, or pass include_others:true.`
              : "No open tasks are assigned to this user. Try include_others:true, or check " +
                "that the account this server is configured with is the right one.";
          return ok(hint, []);
        }

        return ok(`${tasks.length} task(s).`, tasks.map(taskView));
      }),
  );

  /* ------------------------------- log_time ------------------------------ */

  server.registerTool(
    "log_time",
    {
      title: "Log time to a Zoho task",
      description:
        "Create a timesheet entry against a task. Either pass an exact task_id (preferred), " +
        "or a task_name to be matched. If the name match is not confident, this returns " +
        "candidates and logs nothing — ask the user which one they meant and call again " +
        "with that task_id.",
      inputSchema: {
        task_name: z
          .string()
          .optional()
          .describe("Task name as spoken. Ignored if task_id is supplied."),
        task_id: z
          .string()
          .optional()
          .describe("Exact Zoho task id. Use this after a clarification round-trip."),
        project_id: z
          .string()
          .optional()
          .describe(
            "Project the task belongs to. Pass it alongside task_id — it makes the lookup " +
              "one direct request instead of a search.",
          ),
        hours: z.number().positive().describe("Decimal hours, e.g. 2.5 for two and a half hours."),
        date: z.string().describe("Date of the work in YYYY-MM-DD."),
        notes: z.string().optional().describe("Free-text note stored on the timesheet entry."),
        bill_status: z
          .enum(["Billable", "Non Billable"])
          .optional()
          .describe(`Defaults to ZOHO_DEFAULT_BILL_STATUS (currently "${config.defaultBillStatus}").`),
        confirm_duplicate: z
          .boolean()
          .default(false)
          .describe(
            "Set true only after the user has confirmed they really want a second entry on a " +
              "task+date that already has one.",
          ),
        dry_run: z
          .boolean()
          .default(false)
          .describe("Resolve and validate everything, but do not write to Zoho."),
      },
    },
    async (input) =>
      guarded(async () => {
        const {
          task_name,
          task_id,
          project_id,
          hours,
          date,
          notes,
          bill_status,
          confirm_duplicate,
          dry_run,
        } = input;

        const requested = { task_name, task_id, project_id, hours, date, notes, bill_status, dry_run };

        if (!task_id && !task_name) {
          return fail("Provide either task_id or task_name.");
        }

        assertIsoDate(date, "date");
        const hoursHHMM = hoursToHHMM(hours);
        const billStatus = bill_status ?? config.defaultBillStatus;

        // --- resolve the task -------------------------------------------------
        let task: Task | null = null;

        if (task_id) {
          task = await getTaskById(task_id, project_id);
          if (!task) {
            audit({ outcome: "refused_no_match", requested });
            return fail(
              `Could not find task ${task_id}. If it is not assigned to you, pass project_id ` +
                `as well so it can be looked up directly.`,
            );
          }
        } else {
          const pool = await getTasks({ mineOnly: true, openOnly: true });
          if (pool.length === 0) {
            audit({ outcome: "refused_no_match", requested });
            return fail(
              "You have no open tasks to match a name against. Create one with create_task, " +
                "or ask for a task to be assigned to you in Zoho.",
            );
          }

          const result = matchTask(task_name!, pool);

          if (result.kind === "none") {
            audit({
              outcome: "refused_no_match",
              requested,
              candidates: result.candidates.map(candidateView),
            });
            return fail(
              `No task resembles "${task_name}". Nothing was logged. ` +
                `Run get_my_tasks to see the available tasks.` +
                (result.candidates.length
                  ? `\n\nClosest (all below the matching floor):\n${JSON.stringify(
                      result.candidates.map(candidateView),
                      null,
                      2,
                    )}`
                  : ""),
            );
          }

          if (result.kind === "ambiguous") {
            audit({
              outcome: "refused_ambiguous",
              requested,
              candidates: result.candidates.map(candidateView),
            });
            return fail(
              `"${task_name}" is ambiguous — nothing was logged. Ask the user which of these ` +
                `they meant, then call log_time again with that task_id:\n\n` +
                JSON.stringify(result.candidates.map(candidateView), null, 2),
            );
          }

          task = result.task;
          log.info(
            `matched "${task_name}" -> "${task.task_name}" (${result.score.toFixed(2)}, ` +
              `runner-up ${result.runnerUp ? result.runnerUp.score.toFixed(2) : "none"})`,
          );
        }

        const resolved = {
          task_id: task.task_id,
          task_name: task.task_name,
          project_id: task.project_id,
          project_name: task.project_name,
          date,
          hours,
          hours_hhmm: hoursHHMM,
          bill_status: billStatus,
          notes: notes ?? "",
        };

        if (!task.project_id) {
          audit({ outcome: "error", requested, resolved, error: "task has no project id" });
          return fail(
            `Task "${task.task_name}" came back without a project id, which Zoho needs for the ` +
              `timelog endpoint. Try get_my_tasks with refresh:true.`,
          );
        }

        // --- duplicate guard --------------------------------------------------
        if (!confirm_duplicate) {
          // Read only THIS task's logs. Going through listTimeLogs would scan
          // every task the caller owns -- dozens of requests to answer a
          // question about one of them, which trips Zoho's throttle.
          const existing = await fetchTaskLogs(task);
          // Only the caller's own entries count as a duplicate. Tasks are
          // shared, so a colleague's time on the same day is not a clash.
          const clash = existing.filter(
            (l) => l.date === date && (callerIsIdentified() ? isOwnLog(l) : true),
          );
          if (clash.length > 0) {
            audit({ outcome: "refused_duplicate", requested, resolved });
            return fail(
              `There is already time logged on "${task.task_name}" for ${date} ` +
                `(${clash.map((c) => c.hours_display).join(", ")}). Nothing was logged.\n\n` +
                `If this is genuinely a second entry, call log_time again with ` +
                `confirm_duplicate:true. To replace the old one, delete_time_log first.\n\n` +
                JSON.stringify(clash.map(logView), null, 2),
            );
          }
        }

        // --- write ------------------------------------------------------------
        if (dry_run) {
          audit({ outcome: "dry_run", requested, resolved });
          return ok("Dry run — nothing was written to Zoho. This is what would be logged:", resolved);
        }

        try {
          const created = await createTimeLog({
            projectId: task.project_id,
            taskId: task.task_id,
            isoDate: date,
            hoursHHMM,
            notes,
            billStatus,
          });

          audit({ outcome: "created", requested, resolved: { ...resolved, log_id: created.log_id } });

          return ok(
            `Logged ${hours}h (${hoursHHMM}) on ${date}.\n` +
              `Task:    ${task.task_name} [${task.task_id}]\n` +
              `Project: ${task.project_name} [${task.project_id}]\n` +
              `Billing: ${billStatus}\n` +
              `Log id:  ${created.log_id || "(not returned by Zoho)"}`,
            { ...resolved, log_id: created.log_id },
          );
        } catch (err) {
          audit({ outcome: "error", requested, resolved, error: explain(err) });
          throw err;
        }
      }),
  );

  /* -------------------------- get_timesheet_status ------------------------ */

  /**
   * Refuse to mutate a timesheet entry that belongs to someone else.
   *
   * Tasks are shared and get_timesheet_status hands out log ids, so without
   * this one user can delete or rewrite another's time. Returns a refusal to
   * send back, or null when the caller owns the entry.
   */
  async function refuseIfNotOwn(
    logId: string,
    taskId: string,
    projectId: string,
    verb: string,
  ): Promise<ToolResult | null> {
    if (!callerIsIdentified()) {
      return fail(
        `Cannot tell which Zoho user you are, so this entry cannot be confirmed as yours ` +
          `and will not be ${verb === "delete" ? "deleted" : "edited"}. This resolves once ` +
          `you own at least one task in Zoho.`,
      );
    }

    const task = await getTaskById(taskId, projectId);
    if (!task) {
      return fail(`Could not find task ${taskId} in project ${projectId}.`);
    }

    const entry = (await fetchTaskLogs(task)).find((l) => l.log_id === String(logId));
    if (!entry) {
      return fail(`No timesheet entry ${logId} exists on that task.`);
    }

    if (!isOwnLog(entry)) {
      audit({
        outcome: "refused_not_owner",
        requested: { action: `${verb}_time_log`, log_id: logId, task_id: taskId },
        resolved: { owner_name: entry.owner_name },
      });
      return fail(
        `That entry belongs to ${entry.owner_name || "another user"}, not you. ` +
          `You can only ${verb} your own timesheet entries.`,
      );
    }

    return null;
  }

  function logView(l: TimeLog) {
    return {
      log_id: l.log_id,
      date: l.date,
      hours: Number(l.hours.toFixed(2)),
      hours_display: l.hours_display,
      task_id: l.task_id,
      task_name: l.task_name,
      project_name: l.project_name,
      bill_status: l.bill_status,
      notes: l.notes,
    };
  }

  server.registerTool(
    "get_timesheet_status",
    {
      title: "Get timesheet status",
      description:
        "Total hours logged per day over a date range for the signed-in user, so questions " +
        "like 'did I log yesterday?' can be answered. Days with nothing logged are reported " +
        "explicitly as zero. Only that user's own entries are counted.",
      inputSchema: {
        date_from: z.string().describe("Start of the range, inclusive, YYYY-MM-DD."),
        date_to: z.string().describe("End of the range, inclusive, YYYY-MM-DD."),
        include_entries: z
          .boolean()
          .default(false)
          .describe("Also return each individual timesheet entry, not just the daily totals."),
      },
    },
    async ({ date_from, date_to, include_entries }) =>
      guarded(async () => {
        const days = dateRange(date_from, date_to);

        // Without a portal user id every log on the scanned tasks would be
        // returned, including colleagues' — and summed as if it were the
        // caller's. Reporting someone else's hours as yours is worse than
        // reporting nothing, so decline instead.
        if (!callerIsIdentified()) {
          const who = currentUser();
          return fail(
            `Cannot tell which Zoho user you are, so your timesheet cannot be separated ` +
              `from everyone else's — nothing is being reported rather than risk showing ` +
              `you someone else's hours.\n\n` +
              `This resolves automatically once you own at least one task in Zoho` +
              (who?.email ? ` (checked for ${who.email})` : "") +
              `. Use create_task, or ask for a task to be assigned to you.`,
          );
        }

        const logs = await listTimeLogs({ fromIso: date_from, toIso: date_to });

        const totals = new Map<string, number>(days.map((d) => [d, 0]));
        for (const l of logs) {
          if (totals.has(l.date)) totals.set(l.date, totals.get(l.date)! + l.hours);
        }

        const perDay = days.map((d) => ({
          date: d,
          hours: Number((totals.get(d) ?? 0).toFixed(2)),
          logged: (totals.get(d) ?? 0) > 0,
        }));

        const total = perDay.reduce((a, b) => a + b.hours, 0);
        const missing = perDay.filter((d) => !d.logged).map((d) => d.date);

        const summary =
          `${total.toFixed(2)}h logged across ${date_from} → ${date_to}.` +
          (missing.length
            ? ` No time logged on: ${missing.join(", ")}.`
            : " Every day in the range has time logged.");

        return ok(summary, {
          total_hours: Number(total.toFixed(2)),
          days_missing: missing,
          per_day: perDay,
          entries: include_entries ? logs.map(logView) : undefined,
        });
      }),
  );

  /* --------------------------- delete_time_log ---------------------------- */

  server.registerTool(
    "delete_time_log",
    {
      title: "Delete a timesheet entry",
      description:
        "Delete a timesheet entry by its log id. Get the log id from get_timesheet_status " +
        "with include_entries:true, or from the log_time confirmation.",
      inputSchema: {
        log_id: z.string().describe("The timesheet entry id to delete."),
        task_id: z.string().describe("Task the entry belongs to."),
        project_id: z.string().describe("Project the task belongs to."),
      },
    },
    async ({ log_id, task_id, project_id }) =>
      guarded(async () => {
        const refusal = await refuseIfNotOwn(log_id, task_id, project_id, "delete");
        if (refusal) return refusal;

        try {
          await deleteTimeLog(project_id, task_id, log_id);
        } catch (err) {
          audit({
            outcome: "error",
            requested: { action: "delete", log_id, task_id, project_id },
            error: explain(err),
          });
          throw err;
        }
        audit({ outcome: "deleted", requested: { log_id, task_id, project_id } });
        return ok(`Deleted timesheet entry ${log_id} from task ${task_id}.`);
      }),
  );

  /* ------------------------------ create_task ----------------------------- */

  server.registerTool(
    "create_task",
    {
      title: "Create a Zoho task",
      description:
        "Create a task in a project, assigned to you by default, so there is something to " +
        "log time against. Use list_projects to get the project_id first.",
      inputSchema: {
        project_id: z.string().describe("Project to create the task in."),
        name: z.string().min(1).describe("Task name. Keep it distinctive — log_time matches on it."),
        description: z.string().optional().describe("Optional task description."),
        start_date: z.string().optional().describe("YYYY-MM-DD."),
        end_date: z.string().optional().describe("YYYY-MM-DD."),
        priority: z.enum(["None", "Low", "Medium", "High"]).optional(),
        owner_ids: z
          .array(z.string())
          .optional()
          .describe("Zoho zpuid values. Omit to assign the task to yourself."),
      },
    },
    async ({ project_id, name, description, start_date, end_date, priority, owner_ids }) =>
      guarded(async () => {
        if (start_date) assertIsoDate(start_date, "start_date");
        if (end_date) assertIsoDate(end_date, "end_date");

        const task = await createTask({
          projectId: project_id,
          name,
          description,
          startIso: start_date,
          endIso: end_date,
          priority,
          ownerIds: owner_ids,
        });

        audit({
          outcome: "created",
          requested: { action: "create_task", project_id, name, owner_ids },
          resolved: { task_id: task.task_id, task_name: task.task_name },
        });

        return ok(
          `Created task "${task.task_name}" [${task.task_id}] in project ${task.project_id}, ` +
            `assigned to ${task.owner_ids.join(", ")}.`,
          taskView(task),
        );
      }),
  );

  /* -------------------------- list_task_statuses -------------------------- */

  server.registerTool(
    "list_task_statuses",
    {
      title: "List a project's task statuses",
      description:
        "The status names this project's workflow defines. Projects define their own, and " +
        "update_task only accepts one of these — call this first if a status name is rejected.",
      inputSchema: {
        project_id: z.string().describe("Project whose workflow to read."),
      },
    },
    async ({ project_id }) =>
      guarded(async () => {
        const statuses = await listTaskStatuses(project_id);
        if (statuses.length === 0) {
          return fail(
            `Could not read the status list for project ${project_id}. Status changes on ` +
              `this project may not be possible through the API.`,
          );
        }
        return ok(
          `${statuses.length} status(es): ${statuses.map((s2) => s2.name).join(", ")}`,
          statuses,
        );
      }),
  );

  /* ------------------------------ update_task ----------------------------- */

  server.registerTool(
    "update_task",
    {
      title: "Update a Zoho task",
      description:
        "Change a task's status, name, priority, dates or completion. Only the fields you " +
        "pass are altered. Use this to mark work Completed. Status names must match the " +
        "project's own workflow — get_my_tasks shows the current status of each task.",
      inputSchema: {
        task_id: z.string().describe("Task to update."),
        project_id: z.string().describe("Project the task belongs to."),
        status: z
          .string()
          .optional()
          .describe(
            "Status name from this project's own workflow — run list_task_statuses to see " +
              "them. Matching is case- and spacing-insensitive; an unknown name is rejected " +
              "rather than silently ignored.",
          ),
        name: z.string().optional().describe("Rename the task."),
        priority: z.enum(["None", "Low", "Medium", "High"]).optional(),
        description: z.string().optional(),
        start_date: z.string().optional().describe("YYYY-MM-DD."),
        end_date: z.string().optional().describe("YYYY-MM-DD."),
        percent_complete: z.number().min(0).max(100).optional(),
      },
    },
    async ({
      task_id,
      project_id,
      status,
      name,
      priority,
      description,
      start_date,
      end_date,
      percent_complete,
    }) =>
      guarded(async () => {
        if (start_date) assertIsoDate(start_date, "start_date");
        if (end_date) assertIsoDate(end_date, "end_date");

        const nothingToDo =
          [status, name, priority, description, start_date, end_date].every(
            (v) => v === undefined,
          ) && percent_complete === undefined;

        if (nothingToDo) {
          return fail("Nothing to update — pass at least one field to change.");
        }

        const task = await updateTask({
          projectId: project_id,
          taskId: task_id,
          status,
          name,
          priority,
          description,
          startIso: start_date,
          endIso: end_date,
          percentComplete: percent_complete,
        });

        audit({
          outcome: "updated",
          requested: { action: "update_task", task_id, project_id, status, name, priority },
          resolved: { task_id: task.task_id, task_name: task.task_name, status: task.status },
        });

        // Zoho silently ignores a status name its workflow does not define,
        // so report what actually stuck rather than what was asked for.
        const stored = task.status || "(not reported)";
        const mismatch =
          status && task.status && task.status.toLowerCase() !== status.toLowerCase();

        return ok(
          `Updated "${task.task_name}" [${task.task_id}]. Status is now ${stored}.` +
            (mismatch
              ? `\n\nNote: you asked for "${status}" but Zoho stored "${task.status}" — ` +
                `that status name is probably not in this project's workflow.`
              : ""),
          taskView(task),
        );
      }),
  );

  /* --------------------------- update_time_log ---------------------------- */

  server.registerTool(
    "update_time_log",
    {
      title: "Edit a timesheet entry",
      description:
        "Change the hours, date, notes or billing of an existing entry, in place. Get the " +
        "log_id from get_timesheet_status with include_entries:true. Only the fields you " +
        "pass are altered.",
      inputSchema: {
        log_id: z.string().describe("The timesheet entry to edit."),
        task_id: z.string().describe("Task the entry belongs to."),
        project_id: z.string().describe("Project the task belongs to."),
        hours: z.number().positive().optional().describe("New duration in decimal hours."),
        date: z.string().optional().describe("Move the entry to this date, YYYY-MM-DD."),
        notes: z.string().optional().describe("Replace the note."),
        bill_status: z.enum(["Billable", "Non Billable"]).optional(),
      },
    },
    async ({ log_id, task_id, project_id, hours, date, notes, bill_status }) =>
      guarded(async () => {
        if (date) assertIsoDate(date, "date");

        if (hours === undefined && !date && notes === undefined && !bill_status) {
          return fail("Nothing to change — pass at least one of hours, date, notes or bill_status.");
        }

        const refusal = await refuseIfNotOwn(log_id, task_id, project_id, "edit");
        if (refusal) return refusal;

        const hoursHHMM = hours === undefined ? undefined : hoursToHHMM(hours);

        try {
          const updated = await updateTimeLog({
            projectId: project_id,
            taskId: task_id,
            logId: log_id,
            isoDate: date,
            hoursHHMM,
            notes,
            billStatus: bill_status,
          });

          audit({
            outcome: "updated",
            requested: { action: "update_time_log", log_id, task_id, hours, date, notes },
            resolved: { log_id, hours_hhmm: hoursHHMM, date },
          });

          return ok(
            `Updated entry ${log_id}` +
              (hours !== undefined ? ` to ${hours}h (${hoursHHMM})` : "") +
              (date ? ` on ${date}` : "") +
              ".",
            logView(updated),
          );
        } catch (err) {
          audit({
            outcome: "error",
            requested: { action: "update_time_log", log_id, task_id },
            error: explain(err),
          });
          throw err;
        }
      }),
  );

  /* ---------------------------- bulk_log_time ----------------------------- */

  server.registerTool(
    "bulk_log_time",
    {
      title: "Log several timesheet entries at once",
      description:
        "File a whole week in one call. Every entry must carry an exact task_id and " +
        "project_id — no fuzzy matching here, because a wrong guess repeated across a week " +
        "is much worse than a single bad entry. Resolve names with get_my_tasks first.\n\n" +
        "Entries are written one at a time and the result reports each outcome separately, " +
        "so a partial failure is visible rather than silent.",
      inputSchema: {
        entries: z
          .array(
            z.object({
              task_id: z.string(),
              project_id: z.string(),
              hours: z.number().positive(),
              date: z.string().describe("YYYY-MM-DD"),
              notes: z.string().optional(),
              bill_status: z.enum(["Billable", "Non Billable"]).optional(),
            }),
          )
          .min(1)
          .max(30)
          .describe("The entries to file."),
        skip_duplicates: z
          .boolean()
          .default(true)
          .describe(
            "Skip any entry whose task already has time on that date, rather than adding a " +
              "second one. Leave on unless the user has confirmed the duplicates are wanted.",
          ),
        dry_run: z
          .boolean()
          .default(false)
          .describe("Validate everything and report what would be filed, without writing."),
      },
    },
    async ({ entries, skip_duplicates, dry_run }) =>
      guarded(async () => {
        const results: Array<Record<string, unknown>> = [];
        let filed = 0;
        let hoursFiled = 0;

        for (const [i, entry] of entries.entries()) {
          const label = `#${i + 1} ${entry.date} ${entry.hours}h`;

          try {
            assertIsoDate(entry.date, `entries[${i}].date`);
            const hoursHHMM = hoursToHHMM(entry.hours);

            const task = await getTaskById(entry.task_id, entry.project_id);
            if (!task) {
              results.push({ ...entry, status: "failed", reason: "task not found" });
              continue;
            }

            if (skip_duplicates) {
              const existing = await fetchTaskLogs(task);
              const alreadyMine = existing.some(
                (l) => l.date === entry.date && (callerIsIdentified() ? isOwnLog(l) : true),
              );
              if (alreadyMine) {
                results.push({
                  ...entry,
                  task_name: task.task_name,
                  status: "skipped",
                  reason: "time already logged on this task for this date",
                });
                continue;
              }
            }

            if (dry_run) {
              results.push({
                ...entry,
                task_name: task.task_name,
                status: "would_file",
                hours_hhmm: hoursHHMM,
              });
              continue;
            }

            const created = await createTimeLog({
              projectId: task.project_id,
              taskId: task.task_id,
              isoDate: entry.date,
              hoursHHMM,
              notes: entry.notes,
              billStatus: entry.bill_status ?? config.defaultBillStatus,
            });

            filed++;
            hoursFiled += entry.hours;
            audit({
              outcome: "created",
              requested: { action: "bulk_log_time", ...entry },
              resolved: { task_name: task.task_name, log_id: created.log_id },
            });

            results.push({
              ...entry,
              task_name: task.task_name,
              status: "filed",
              log_id: created.log_id,
            });
          } catch (err) {
            const reason = explain(err);
            audit({
              outcome: "error",
              requested: { action: "bulk_log_time", ...entry },
              error: reason,
            });
            results.push({ ...entry, status: "failed", reason });
            log.warn(`bulk_log_time ${label} failed`, reason);
          }
        }

        const counts = results.reduce<Record<string, number>>((acc, r) => {
          const k = String(r.status);
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {});

        const summary = dry_run
          ? `Dry run — nothing written. ${counts.would_file ?? 0} entr(ies) would be filed, ` +
            `${counts.skipped ?? 0} skipped, ${counts.failed ?? 0} could not be resolved.`
          : `Filed ${filed} of ${entries.length} entr(ies), ${hoursFiled.toFixed(2)}h total. ` +
            `${counts.skipped ?? 0} skipped as duplicates, ${counts.failed ?? 0} failed.`;

        return ok(summary, { wrote_to_zoho: !dry_run && filed > 0, results });
      }),
  );

  /* --------------------- import_omi_conversations ------------------------- *
   * Optional path. Read-only: it proposes entries and never writes to Zoho.
   * ------------------------------------------------------------------------ */

  server.registerTool(
    "import_omi_conversations",
    {
      title: "Draft timesheet entries from an Omi export (optional)",
      description:
        "OPTIONAL, for people who use Omi. Turns an Omi conversations JSON export into a " +
        "DRAFT list of proposed timesheet entries, grouped by day. This tool NEVER writes " +
        "to Zoho — it only proposes. To file anything, the user must approve entries and " +
        "you then call log_time separately for each approved one, passing its task_id.\n\n" +
        "Drafts marked needs_review are low-confidence and must NOT be included in any " +
        "'file all' shortcut; ask the user to pick a task for each of those individually.",
      inputSchema: {
        conversations_json: z
          .string()
          .min(2)
          .describe(
            "Raw JSON from Omi: a top-level array, or an object with a conversations/memories array.",
          ),
        min_minutes: z
          .number()
          .min(0)
          .default(5)
          .describe("Ignore conversations shorter than this. Omi captures a lot of short noise."),
        round_to_minutes: z
          .number()
          .min(0)
          .default(15)
          .describe("Round each duration to this granularity. 0 keeps the exact duration."),
        utc_offset_minutes: z
          .number()
          .min(-840)
          .max(840)
          .default(0)
          .describe(
            "Offset used to decide which calendar day a conversation falls on. 0 = UTC. " +
              "For IST pass 330.",
          ),
        include_others: z
          .boolean()
          .default(false)
          .describe("Match against the whole portal's tasks, not just this user's. Riskier."),
      },
    },
    async ({
      conversations_json,
      min_minutes,
      round_to_minutes,
      utc_offset_minutes,
      include_others,
    }) =>
      guarded(async () => {
        const conversations = parseOmiConversations(conversations_json, utc_offset_minutes);
        if (conversations.length === 0) {
          return ok("That export contained no conversations. Nothing to propose.", { drafts: [] });
        }

        const tasks = await getTasks({ mineOnly: !include_others, openOnly: true });
        if (tasks.length === 0) {
          return fail(
            "No open tasks are available to match against, so no drafts could be built. " +
              "Run get_my_tasks to check the configuration.",
          );
        }

        const drafts = buildDrafts(conversations, tasks, {
          minMinutes: min_minutes,
          roundToMinutes: round_to_minutes,
          utcOffsetMinutes: utc_offset_minutes,
        });

        const ready = drafts.filter((d) => d.status === "ready");
        const review = drafts.filter((d) => d.status === "needs_review");
        const skipped = drafts.filter((d) => d.status === "skipped");
        const suggested = rollUp(drafts);
        const readyHours = suggested.reduce((a, e) => a + e.hours, 0);

        const summary =
          `DRAFT ONLY — nothing has been written to Zoho.\n\n` +
          `${conversations.length} conversation(s) parsed: ` +
          `${ready.length} confidently matched, ${review.length} need review, ` +
          `${skipped.length} skipped.\n` +
          `The confident ones roll up to ${suggested.length} proposed entr(ies) ` +
          `totalling ${readyHours.toFixed(2)}h.\n\n` +
          (suggested.length
            ? `To file them, call log_time once per entry in suggested_entries, using its ` +
              `task_id, hours and date.\n`
            : `There is nothing safe to file automatically.\n`) +
          (review.length
            ? `The ${review.length} needs_review item(s) are deliberately excluded from ` +
              `suggested_entries. Ask the user which task each belongs to before filing any of them.`
            : "");

        return ok(summary, {
          wrote_to_zoho: false,
          suggested_entries: suggested,
          needs_review: review,
          skipped,
          by_day: groupByDay(drafts),
        });
      }),
  );

  return server;
}
