import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "./config.js";
import { currentUser, discoveries, effective } from "./context.js";
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
import { getAttendance } from "./people.js";
import {
  assertIsoDate,
  dateRange,
  hoursToHHMM,
} from "./format.js";
import {
  rememberedProjects,
  rollUpDays,
  sweepTimeLogs,
  type Coverage,
  type Undetermined,
} from "./timesheet.js";
import {
  callerIsIdentified,
  createTask,
  createTimeLog,
  deleteTimeLog,
  ensureCallerUserId,
  fetchTaskLogs,
  getPortalMeta,
  getTaskById,
  getTasks,
  isOwnLog,
  listActiveProjectsCached,
  listProjects,
  listTaskStatuses,
  PROJECT_SWEEP_CAP,
  taskIsMine,
  updateTask,
  updateTimeLog,
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

function fail(text: string, data?: unknown): ToolResult {
  const body = data === undefined ? text : `${text}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: "text", text: body }], isError: true };
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

/**
 * Who this server is acting as, rendered for a human.
 *
 * Every "nothing to match against" path prints this. An empty task pool looks
 * identical whether the connection is broken or the caller is simply signed in
 * as someone who owns no tasks -- and the second is far more likely. Without
 * the acting identity in the message that is near-impossible to tell apart
 * from the outside, and the obvious guess (a broken token) is the wrong one.
 */
function actingAs(): string {
  const { label, userId, timelogOwnerId, portalId } = effective();
  const ids = [
    timelogOwnerId ? `user id ${timelogOwnerId}` : "user id unknown",
    userId ? `login zpuid ${userId}` : "",
    `portal ${portalId}`,
  ]
    .filter(Boolean)
    .join(", ");
  return `${label} (${ids})`;
}

/**
 * The one explanation for "we do not know which Zoho user you are". Every
 * tool that needs the identity points here, so nobody is bounced between two
 * tools that each say the other will fix it.
 */
function identityUnresolved(): { text: string; resolution: string[] } {
  const who = currentUser();
  return {
    text:
      `Cannot tell which Zoho user ${actingAs()} is: Zoho's /portals/ endpoint did not report a ` +
      `login_id for this token.`,
    resolution: who
      ? [
          "Disconnect and reconnect the Timesheet connector so the Zoho account is re-read.",
          "If it persists, this Zoho account may not be a member of the portal; ask the portal admin.",
        ]
      : [
          "Set ZOHO_TIMELOG_OWNER_ID in .env to your Zoho user id (the `id` on your entry in " +
            "the portal user list).",
        ],
  };
}

/** A structured, machine-readable "could not determine" that never reads as a zero. */
function undetermined(reason: Undetermined | { reason_code: string; message: string }, extra?: Record<string, unknown>): ToolResult {
  const resolution =
    reason.reason_code === "identity_unknown"
      ? identityUnresolved().resolution
      : reason.reason_code === "no_projects_to_scan"
        ? [
            "Pass project_name (or project_id) to read a specific project.",
            "Have a Zoho task assigned to you, or create one with create_task (it is assigned to you).",
            "Once this connector has logged time for you, it remembers the project and reads it back.",
          ]
        : reason.reason_code === "too_many_projects"
          ? ["Narrow project_name so fewer projects match, or shorten the date range."]
          : reason.reason_code === "attendance_unavailable"
            ? [
                "Check that the connected Zoho account has ZohoPeople.attendance.READ (reconnect if not).",
                "Check that the account's email exists as an employee in Zoho People.",
              ]
            : [];
  return fail(`Could not determine the answer — this is NOT a zero. ${reason.message}`, {
    status: "undetermined",
    reason_code: reason.reason_code,
    acting_as: actingAs(),
    resolution,
    ...extra,
  });
}

/** How to look at colleagues' tasks on a portal this size. */
function othersHint(projectName?: string): string {
  return (
    `get_my_tasks with include_others:true and project_name:` +
    `${projectName ? `"${projectName}"` : "<project>"} (this portal has too many projects to ` +
    `scan without a project name; list_projects shows them)`
  );
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
    owners: t.owners.map((o) => o.name || o.email || o.portalUserId).filter(Boolean),
    /** true = assigned to you, false = someone else's, null = cannot tell. */
    mine: taskIsMine(t),
  };
}

function logView(l: TimeLog) {
  return {
    log_id: l.log_id,
    date: l.date,
    hours: Number(l.hours.toFixed(2)),
    hours_display: l.hours_display,
    task_id: l.task_id,
    task_name: l.task_name,
    project_id: l.project_id,
    project_name: l.project_name,
    bill_status: l.bill_status,
    notes: l.notes,
    owner_id: l.owner_id,
    owner_name: l.owner_name,
    component: l.component,
  };
}

function coverageView(c: Coverage) {
  return {
    /**
     * The field to branch on. False means "hours not found here" — it does NOT
     * mean "no hours logged", so a zero day must not be treated as free.
     */
    covers_whole_timesheet: c.covers_whole_timesheet,
    incomplete_because: c.incomplete_because,
    basis: c.basis,
    projects_scanned: c.projects_scanned,
    projects_unscanned: c.projects_unscanned,
    projects_visible: c.projects_visible,
    months: c.months,
    months_unknown: c.months_unknown,
    components_counted: c.components,
    components_not_counted: ["bug"],
    scan_errors: c.failures,
    throttled: c.throttled,
    truncated: c.truncated,
    users_list_fallbacks: c.users_list_fallbacks,
    zoho_requests: c.requests,
    own_task_check: c.own_task_check,
  };
}

/** One sentence about what a sweep could not see, or "" when it saw everything. */
function coverageCaveat(c: Coverage): string {
  const parts = [...c.incomplete_because];
  if (c.own_task_check && c.own_task_check.extra_logs_found > 0) {
    parts.push(
      `the per-task cross-check found ${c.own_task_check.extra_logs_found} entr(ies) the ` +
        `project view had missed (they are counted)`,
    );
  }
  return parts.length ? `This read was NOT complete: ${parts.join("; ")}.` : "";
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
    { name: "zoho-timesheet", version: "1.1.0" },
    {
      instructions:
        "Files Zoho Projects timesheet entries. Prefer calling get_my_tasks first and " +
        "passing the exact task_id to log_time. If log_time reports an ambiguous match, " +
        "ask the user which candidate they meant instead of picking one. A get_timesheet_status " +
        "result with status \"undetermined\" or days_unknown is NOT zero hours — do not file " +
        "against those days without confirming with the user.",
    },
  );

  /* -------------------------------- whoami ------------------------------- */

  /**
   * Answers "which Zoho user is this server acting as, and does that user own
   * anything?" -- the first question to ask when a name match finds nothing,
   * and previously not answerable by any tool. Never throws: a diagnostic that
   * fails when things are broken is worthless, so partial answers are returned
   * with the errors attached.
   */
  server.registerTool(
    "whoami",
    {
      title: "Show which Zoho user this server acts as",
      description:
        "Report the Zoho identity, portal, task counts and timesheet-read basis this server is " +
        "operating with. Call this first whenever log_time or get_my_tasks reports that no tasks " +
        "exist — an empty task list is far more often the wrong account or an unassigned task " +
        "than a missing one.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const user = currentUser();
        const problems: string[] = [];

        try {
          await ensureCallerUserId();
        } catch (err) {
          problems.push(`Could not resolve the Zoho user id: ${explain(err)}`);
        }
        const eff = effective();

        let portalName = "(unknown)";
        try {
          portalName = (await getPortalMeta()).name;
        } catch (err) {
          problems.push(`Could not read portal metadata: ${explain(err)}`);
        }

        let mine: Task[] = [];
        let counted = false;
        try {
          mine = await getTasks({ mineOnly: true, openOnly: false });
          counted = true;
        } catch (err) {
          problems.push(`Could not count assigned tasks: ${explain(err)}`);
        }

        let projectsVisible: number | string = "(unavailable)";
        try {
          projectsVisible = (await listActiveProjectsCached()).length;
        } catch (err) {
          problems.push(`Could not list projects: ${explain(err)}`);
        }

        const remembered = rememberedProjects();
        const openCount = mine.filter((t) => !t.completed).length;
        const identity = {
          mode: user ? "signed-in user (OAuth)" : "service account (.env)",
          email: user?.email || "(not reported)",
          name: user?.name || "(not reported)",
          user_id: eff.timelogOwnerId || "(unknown)",
          user_id_meaning:
            "Zoho's id for you: stamped on your timelogs as owner_id, on task owner records " +
            "as id, and what create_task assigns. Also reported as timelog_owner_id.",
          user_id_source: user?.portalUserIdSource || (eff.timelogOwnerId ? "config" : ""),
          timelog_owner_id: eff.timelogOwnerId || "(unknown)",
          login_zpuid: eff.userId || "(not set)",
          login_zpuid_meaning:
            "The server's key for you. It is NOT the zpuid on task owner records; do not compare them.",
          portal_id: eff.portalId,
          portal_name: portalName,
          can_verify_own_timelogs: callerIsIdentified(),
          tasks_assigned: counted ? mine.length : "(unavailable)",
          tasks_open: counted ? openCount : "(unavailable)",
          projects_visible: projectsVisible,
          projects_written_via_connector: remembered,
          timesheet_read_basis:
            "get_timesheet_status reads the projects of your own tasks plus the projects this " +
            "connector has written to for you; pass project_name to read another project.",
        };

        const verdict =
          counted && mine.length === 0
            ? `\n\nThis user owns NO tasks in portal ${portalName}, so there is nothing for ` +
              `log_time to match a task name against. That is a Zoho assignment question, not a ` +
              `connection fault. If tasks were created for you through create_task before ` +
              `2026-09-05, Zoho may have assigned them to someone else or left them unassigned: ` +
              `find them with ${othersHint()}, then run update_task with assign_to_me:true on ` +
              `each. Otherwise ask for a task to be assigned, or use create_task — it now ` +
              `assigns the task to you and verifies that.`
            : "";

        return ok(
          `Acting as ${actingAs()}.` +
            verdict +
            (problems.length ? `\n\nProblems:\n- ${problems.join("\n- ")}` : ""),
          identity,
        );
      }),
  );

  /* ---------------------------- list_projects ---------------------------- */

  server.registerTool(
    "list_projects",
    {
      title: "List Zoho projects",
      description:
        "List the projects visible to the signed-in Zoho account. Cheap; use this to " +
        "narrow get_my_tasks or get_timesheet_status with project_name when the portal has " +
        "many projects.",
      inputSchema: {
        include_inactive: z
          .boolean()
          .default(false)
          .describe("Include archived/closed projects as well as active ones."),
      },
    },
    async ({ include_inactive }) =>
      guarded(async () => {
        const projects = include_inactive
          ? await listProjects(false)
          : await listActiveProjectsCached();
        return ok(`${projects.length} project(s) visible to ${effective().label}.`, projects);
      }),
  );

  /* ---------------------------- get_my_tasks ----------------------------- */

  server.registerTool(
    "get_my_tasks",
    {
      title: "Get my Zoho tasks",
      description:
        "List tasks assigned to the signed-in Zoho user across all projects in the " +
        "portal, so a spoken task name can be resolved to a real task_id before logging time. " +
        "With include_others:true and project_name, lists everyone's tasks in matching projects; " +
        "each task carries `mine` (true/false/null) and its owners.",
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
              "name matching much riskier. On a large portal it needs project_name too.",
          ),
        refresh: z
          .boolean()
          .default(false)
          .describe("Bypass the in-memory task cache and refetch from Zoho."),
      },
    },
    async ({ project_name, include_completed, include_others, refresh }) =>
      guarded(async () => {
        await ensureCallerUserId().catch(() => "");
        const tasks = await getTasks({
          projectName: project_name,
          openOnly: !include_completed,
          mineOnly: !include_others,
          forceRefresh: refresh,
        });

        if (tasks.length === 0) {
          const scope = include_completed ? "tasks" : "open tasks";
          const hint = include_others
            ? `No ${scope} matched those filters (searched as ${actingAs()}).`
            : `No ${scope} are assigned to ${actingAs()}.\n\n` +
              `Before assuming the task is missing, run whoami to confirm this is the right ` +
              `Zoho account, and retry with ${othersHint(project_name)} — the task often exists ` +
              `but is assigned to a colleague or to nobody. Otherwise ask for it to be assigned, ` +
              `or use create_task.`;
          return ok(hint, []);
        }

        const views = tasks.map(taskView);
        const unknownOwnership = views.some((v) => v.mine === null);
        const note = unknownOwnership
          ? `\n\nOwnership (\`mine\`) could not be determined for some tasks because ` +
            `${identityUnresolved().text}`
          : "";
        return ok(`${tasks.length} task(s).${note}`, views);
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

        // Knowing who we are lets the duplicate guard ignore colleagues' entries.
        await ensureCallerUserId().catch(() => "");

        // --- resolve the task -------------------------------------------------
        let task: Task | null = null;

        if (task_id) {
          task = await getTaskById(task_id, project_id);
          if (!task) {
            audit({ outcome: "refused_no_match", requested });
            return fail(
              `Could not find task ${task_id} as ${actingAs()}. If it is not assigned to you, ` +
                `pass project_id as well so it can be looked up directly.`,
            );
          }
        } else {
          // Completed tasks stay in the pool. Zoho accepts timelogs against a
          // closed task, and the usual rhythm is to create a task, close it,
          // and only then log the day's hours -- so filtering to open tasks
          // hid exactly the task the caller meant and left no way to reach it
          // by name.
          const pool = await getTasks({ mineOnly: true, openOnly: false });
          if (pool.length === 0) {
            audit({ outcome: "refused_no_match", requested });
            return fail(
              `No Zoho tasks are assigned to ${actingAs()}, so there is nothing to match ` +
                `"${task_name}" against. Nothing was logged.\n\n` +
                `An empty task list usually means the wrong account, or a task that exists but is ` +
                `assigned to someone else. Run whoami to see which Zoho user this server is acting ` +
                `as, and ${othersHint()} to find the task; if it is yours, update_task with ` +
                `assign_to_me:true makes it matchable. If it genuinely does not exist, create_task ` +
                `will make one assigned to you.`,
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
              `No task resembles "${task_name}" among the ${pool.length} task(s) assigned to ` +
                `${actingAs()}. Nothing was logged.` +
                (result.candidates.length
                  ? `\n\nClosest (all below the matching floor):\n${JSON.stringify(
                      result.candidates.map(candidateView),
                      null,
                      2,
                    )}`
                  : `\n\nNothing came close, which often means the task belongs to someone ` +
                    `else — ${othersHint()} will show it if so.`),
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
          // Surfaced because the pool no longer hides closed tasks: logging
          // against one is legitimate, but the caller should see that is what
          // happened rather than discover it in Zoho later.
          task_completed: task.completed,
          task_mine: taskIsMine(task),
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
          // Read only THIS task's logs. Going through the timesheet sweep would
          // read every project the caller touches -- dozens of requests to
          // answer a question about one task.
          const existing = await fetchTaskLogs(task);
          // Only the caller's own entries count as a duplicate. Tasks are
          // shared, so a colleague's time on the same day is not a clash --
          // unless we cannot tell whose it is, in which case it is reported as
          // such rather than assumed to be either.
          const identified = callerIsIdentified();
          const clash = existing.filter((l) => l.date === date && (identified ? isOwnLog(l) : true));
          if (clash.length > 0) {
            audit({ outcome: "refused_duplicate", requested, resolved });
            const whose = identified
              ? "your"
              : `an entry by ${clash.map((c) => c.owner_name || c.owner_id || "someone").join(", ")} ` +
                `— possibly yours, but ${identityUnresolved().text} so it cannot be confirmed as`;
            return fail(
              `There is already ${whose} time logged on "${task.task_name}" for ${date} ` +
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

          const conflict = discoveries().ownerIdConflict;
          const conflictNote = conflict
            ? `\n\nWARNING: Zoho stamped this entry with user id ${conflict.observed}, but this ` +
              `server believed you were ${conflict.believed}. The entry is filed under whoever ` +
              `${conflict.observed} is. Run whoami and, if the ids still disagree, reconnect.`
            : "";

          return ok(
            `Logged ${hours}h (${hoursHHMM}) on ${date}.\n` +
              `Task:    ${task.task_name} [${task.task_id}]` +
              `${task.completed ? " (closed task)" : ""}` +
              `${resolved.task_mine === false ? " (assigned to someone else — that is fine, the entry is yours)" : ""}\n` +
              `Project: ${task.project_name} [${task.project_id}]\n` +
              `Billing: ${created.bill_status || billStatus}\n` +
              `Owner:   ${created.owner_name || "(not returned)"} [${created.owner_id || "?"}]\n` +
              `Log id:  ${created.log_id || "(not returned by Zoho)"}` +
              conflictNote,
            { ...resolved, log_id: created.log_id, owner_id: created.owner_id, owner_name: created.owner_name },
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
    await ensureCallerUserId().catch(() => "");
    if (!callerIsIdentified()) {
      const why = identityUnresolved();
      return fail(
        `${why.text} This entry cannot be confirmed as yours and will not be ` +
          `${verb === "delete" ? "deleted" : "edited"}.\n\n- ${why.resolution.join("\n- ")}`,
      );
    }

    const task = await getTaskById(taskId, projectId);
    if (!task) {
      return fail(`Could not find task ${taskId} in project ${projectId} as ${actingAs()}.`);
    }

    const entry = (await fetchTaskLogs(task)).find((l) => l.log_id === String(logId));
    if (!entry) {
      return fail(`No timesheet entry ${logId} exists on that task.`);
    }

    if (!isOwnLog(entry)) {
      audit({
        outcome: "refused_not_owner",
        requested: { action: `${verb}_time_log`, log_id: logId, task_id: taskId },
        resolved: { owner_name: entry.owner_name, owner_id: entry.owner_id },
      });
      return fail(
        `That entry belongs to ${entry.owner_name || "another user"} [${entry.owner_id}], not ` +
          `${actingAs()}. You can only ${verb} your own timesheet entries.`,
      );
    }

    return null;
  }

  server.registerTool(
    "get_timesheet_status",
    {
      title: "Get timesheet status",
      description:
        "Hours logged per day over a date range for the signed-in user, so questions like " +
        "'did I log yesterday?' can be answered. Reads the projects of the user's own tasks " +
        "plus the projects this connector has written to for them (or the projects named by " +
        "project_name / project_id). Each day is logged:true, false (confirmed empty) or null " +
        "(could not be read); days_missing lists only confirmed-empty days. A result with " +
        "status \"undetermined\" means nothing could be read — it is not zero. Task and general " +
        "time logs are counted; bug logs are not.",
      inputSchema: {
        date_from: z.string().describe("Start of the range, inclusive, YYYY-MM-DD."),
        date_to: z.string().describe("End of the range, inclusive, YYYY-MM-DD."),
        include_entries: z
          .boolean()
          .default(false)
          .describe("Also return each individual timesheet entry, not just the daily totals."),
        project_name: z
          .string()
          .optional()
          .describe(
            "Read only projects whose name contains this (case-insensitive). Use it to check a " +
              "project you are about to log against, or one you own no tasks in.",
          ),
        project_id: z.string().optional().describe("Read only this project."),
      },
    },
    async ({ date_from, date_to, include_entries, project_name, project_id }) =>
      guarded(async () => {
        const days = dateRange(date_from, date_to);
        await ensureCallerUserId().catch(() => "");

        const sweep = await sweepTimeLogs({
          fromIso: date_from,
          toIso: date_to,
          projectFilter:
            project_name || project_id
              ? { ids: project_id ? [project_id] : undefined, nameNeedle: project_name }
              : undefined,
        });

        if (sweep.undetermined) {
          return undetermined(sweep.undetermined, { coverage: coverageView(sweep.coverage) });
        }

        const perDay = rollUpDays(days, sweep.logs, sweep.coverage);
        const total = perDay.reduce((a, b) => a + b.hours, 0);
        const missing = perDay.filter((d) => d.logged === false).map((d) => d.date);
        const unknown = perDay.filter((d) => d.logged === null).map((d) => d.date);
        const complete = sweep.coverage.covers_whole_timesheet;
        const scanned = sweep.coverage.projects_scanned.map((p) => p.project_name || p.project_id);
        const caveat = coverageCaveat(sweep.coverage);

        const summary =
          `${total.toFixed(2)}h found for ${date_from} → ${date_to} in ` +
          `${scanned.length} project(s) read${scanned.length ? `: ${scanned.join(", ")}` : ""}.` +
          (complete ? "" : " This is a LOWER BOUND, not a total.") +
          (missing.length ? ` Confirmed no time logged on: ${missing.join(", ")}.` : "") +
          (unknown.length
            ? ` No time was found for ${unknown.join(", ")}, but that could not be confirmed — ` +
              `do NOT treat those days as empty or file against them without asking the user.`
            : "") +
          (complete && !missing.length && !unknown.length
            ? " Every day in the range has time logged."
            : "") +
          (caveat ? `\n\n${caveat}` : "");

        return ok(summary, {
          // Named as a lower bound because that is what a per-project sweep can
          // honestly promise; `coverage.covers_whole_timesheet` says whether it
          // is also the total.
          total_hours_found: Number(total.toFixed(2)),
          is_complete: complete,
          days_missing: missing,
          days_unknown: unknown,
          per_day: perDay,
          coverage: coverageView(sweep.coverage),
          entries: include_entries ? sweep.logs.map(logView) : undefined,
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
        "Create a task in a project, assigned to you (verified from Zoho's response), so there " +
        "is something to log time against. Use list_projects to get the project_id first. You " +
        "must be a member of the project.",
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
          .describe(
            "Zoho user ids (the 600... number whoami reports as user_id / timelog_owner_id — " +
              "NOT a zpuid) to assign instead of yourself. Omit to assign the task to yourself.",
          ),
      },
    },
    async ({ project_id, name, description, start_date, end_date, priority, owner_ids }) =>
      guarded(async () => {
        if (start_date) assertIsoDate(start_date, "start_date");
        if (end_date) assertIsoDate(end_date, "end_date");

        const { task, callerUserId, assignedToCaller } = await createTask({
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
          resolved: {
            task_id: task.task_id,
            task_name: task.task_name,
            project_id: task.project_id,
            project_name: task.project_name,
            owners: task.owners.map((o) => o.portalUserId),
            assigned_to_caller: assignedToCaller,
          },
        });

        const owners = task.owners.map((o) => `${o.name || o.email || "?"} [${o.portalUserId}]`);
        const explicit = Boolean(owner_ids?.length);
        const assignment = explicit
          ? `Assigned to ${owners.join(", ") || owner_ids!.join(", ")}.`
          : assignedToCaller === true
            ? `Assigned to you (${callerUserId}) — it will appear in get_my_tasks.`
            : assignedToCaller === false
              ? `WARNING: Zoho did NOT assign it to you (${callerUserId}); owners reported: ` +
                `${owners.join(", ") || "none"}. It will not appear in get_my_tasks and log_time ` +
                `cannot match it by name. Run update_task with assign_to_me:true, or ask the ` +
                `project admin to add you to project ${project_id}.`
              : `Zoho did not report owners for the new task; check it with get_my_tasks.`;

        return ok(
          `Created task "${task.task_name}" [${task.task_id}] in project ` +
            `${task.project_name || task.project_id} [${task.project_id}]. ${assignment}`,
          { ...taskView(task), assigned_to_caller: explicit ? null : assignedToCaller },
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
        "Change a task's status, name, priority, dates or completion, or assign it to yourself. " +
        "Only the fields you pass are altered. Use this to mark work Completed. Status names " +
        "must match the project's own workflow — get_my_tasks shows the current status of each task.",
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
        assign_to_me: z
          .boolean()
          .default(false)
          .describe(
            "Make yourself the task's owner, so it shows in get_my_tasks and log_time can match " +
              "it by name. Use it to repair tasks create_task made before 2026-09-05.",
          ),
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
      assign_to_me,
    }) =>
      guarded(async () => {
        if (start_date) assertIsoDate(start_date, "start_date");
        if (end_date) assertIsoDate(end_date, "end_date");

        const nothingToDo =
          [status, name, priority, description, start_date, end_date].every(
            (v) => v === undefined,
          ) &&
          percent_complete === undefined &&
          !assign_to_me;

        if (nothingToDo) {
          return fail("Nothing to update — pass at least one field to change.");
        }

        const { task, assignedToCaller, callerUserId } = await updateTask({
          projectId: project_id,
          taskId: task_id,
          status,
          name,
          priority,
          description,
          startIso: start_date,
          endIso: end_date,
          percentComplete: percent_complete,
          assignToMe: assign_to_me,
        });

        audit({
          outcome: "updated",
          requested: {
            action: "update_task",
            task_id,
            project_id,
            status,
            name,
            priority,
            assign_to_me,
          },
          resolved: {
            task_id: task.task_id,
            task_name: task.task_name,
            status: task.status,
            owners: task.owners.map((o) => o.portalUserId),
          },
        });

        // Zoho silently ignores a status name its workflow does not define,
        // so report what actually stuck rather than what was asked for.
        const stored = task.status || "(not reported)";
        const mismatch =
          status && task.status && task.status.toLowerCase() !== status.toLowerCase();

        const assignment = assign_to_me
          ? assignedToCaller === true
            ? `\nIt is now assigned to you (${callerUserId}).`
            : assignedToCaller === false
              ? `\nWARNING: Zoho did not make you (${callerUserId}) an owner; owners reported: ` +
                `${task.owners.map((o) => o.name || o.portalUserId).join(", ") || "none"}.`
              : `\nZoho did not report the owners back; check with get_my_tasks.`
          : "";

        return ok(
          `Updated "${task.task_name}" [${task.task_id}]. Status is now ${stored}.` +
            assignment +
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
        await ensureCallerUserId().catch(() => "");
        const identified = callerIsIdentified();

        const results: Array<Record<string, unknown>> = [];
        let filed = 0;
        let hoursFiled = 0;
        const taskLogCache = new Map<string, TimeLog[]>();

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
              // One read per task, not per entry: a week on one task is one call.
              let existing = taskLogCache.get(task.task_id);
              if (!existing) {
                existing = await fetchTaskLogs(task);
                taskLogCache.set(task.task_id, existing);
              }
              const clash = existing.filter(
                (l) => l.date === entry.date && (identified ? isOwnLog(l) : true),
              );
              if (clash.length > 0) {
                results.push({
                  ...entry,
                  task_name: task.task_name,
                  status: "skipped",
                  reason: identified
                    ? "you already have time logged on this task for this date"
                    : `an entry by ${clash.map((c) => c.owner_name || c.owner_id).join(", ")} ` +
                      `exists for this date and your identity is unverified, so it may be yours`,
                  existing: clash.map(logView),
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
            taskLogCache.get(task.task_id)?.push(created);

            filed++;
            hoursFiled += entry.hours;
            audit({
              outcome: "created",
              requested: { action: "bulk_log_time", ...entry },
              resolved: {
                task_name: task.task_name,
                project_id: task.project_id,
                project_name: task.project_name,
                log_id: created.log_id,
              },
            });

            results.push({
              ...entry,
              task_name: task.task_name,
              status: "filed",
              log_id: created.log_id,
              owner_id: created.owner_id,
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

        const conflict = discoveries().ownerIdConflict;
        const summary =
          (dry_run
            ? `Dry run — nothing written. ${counts.would_file ?? 0} entr(ies) would be filed, ` +
              `${counts.skipped ?? 0} skipped, ${counts.failed ?? 0} could not be resolved.`
            : `Filed ${filed} of ${entries.length} entr(ies), ${hoursFiled.toFixed(2)}h total. ` +
              `${counts.skipped ?? 0} skipped as duplicates, ${counts.failed ?? 0} failed.`) +
          (conflict
            ? `\n\nWARNING: Zoho stamped the entries with user id ${conflict.observed}, but this ` +
              `server believed you were ${conflict.believed}. Run whoami and reconnect if they ` +
              `still disagree.`
            : "");

        return ok(summary, { wrote_to_zoho: !dry_run && filed > 0, results });
      }),
  );

  /* ---------------------------- get_attendance ---------------------------- */

  server.registerTool(
    "get_attendance",
    {
      title: "Get Zoho People check-in / check-out times",
      description:
        "Read the signed-in user's attendance from Zoho People over a date range: first " +
        "check-in, last check-out, and the hours People says were actually worked. " +
        "Read-only — it never writes a timesheet entry. Use plan_timesheet_from_attendance " +
        "when the goal is to fill the timesheet from these hours.",
      inputSchema: {
        date_from: z.string().describe("Start of the range, inclusive, YYYY-MM-DD."),
        date_to: z.string().describe("End of the range, inclusive, YYYY-MM-DD."),
      },
    },
    async ({ date_from, date_to }) =>
      guarded(async () => {
        const days = dateRange(date_from, date_to);
        const { subject, days: attendance, available } = await getAttendance(
          date_from,
          date_to,
          days,
        );

        if (!available) {
          return fail(
            `Zoho People returned no attendance records at all for ${subject.label} over ` +
              `${date_from} → ${date_to}. That cannot be told apart from "absent every day", so ` +
              `it is not being reported as zero. Usually the token lacks ` +
              `ZohoPeople.attendance.READ or the email is not an employee in People.`,
            { status: "undetermined", reason_code: "attendance_unavailable", subject: subject.label },
          );
        }

        const worked = attendance.filter((d) => d.hours > 0);
        const total = worked.reduce((a, d) => a + d.hours, 0);

        return ok(
          `${subject.label}: ${total.toFixed(2)}h of attendance across ` +
            `${worked.length} of ${days.length} day(s), ${date_from} → ${date_to}.`,
          {
            subject: subject.label,
            attendance_available: true,
            total_hours: Number(total.toFixed(2)),
            days: attendance,
          },
        );
      }),
  );

  /* ------------------ plan_timesheet_from_attendance ---------------------- *
   * Read-only. Attendance says HOW LONG the day was; it cannot say WHAT the
   * time was spent on, and inventing that split would put fabricated work in
   * a system of record. So this proposes and stops.
   * ------------------------------------------------------------------------ */

  server.registerTool(
    "plan_timesheet_from_attendance",
    {
      title: "Plan timesheet entries from attendance",
      description:
        "Compare Zoho People attendance against what is already on the Zoho Projects " +
        "timesheet, and return the shortfall per day alongside the user's tasks. " +
        "This tool NEVER writes to Zoho.\n\n" +
        "Attendance knows how long the day was but not what it was spent on, so you MUST " +
        "ask the user which task each day's hours belong to, then call log_time per day " +
        "with that task_id. Do not pick a task yourself, and do not file a day whose " +
        "shortfall is zero.\n\n" +
        "Read already_logged_is_complete: when it is false the shortfalls are a MAXIMUM " +
        "(time logged in a project that could not be read would not appear), so confirm each " +
        "day with the user before filing. hours_to_log null means the timesheet could not be " +
        "read for that day — never file it.",
      inputSchema: {
        date_from: z.string().describe("Start of the range, inclusive, YYYY-MM-DD."),
        date_to: z.string().describe("End of the range, inclusive, YYYY-MM-DD."),
        project_name: z
          .string()
          .optional()
          .describe("Read the timesheet of only the projects whose name contains this."),
      },
    },
    async ({ date_from, date_to, project_name }) =>
      guarded(async () => {
        const days = dateRange(date_from, date_to);
        await ensureCallerUserId().catch(() => "");

        const [attendanceResult, sweep, tasks] = await Promise.all([
          getAttendance(date_from, date_to, days),
          sweepTimeLogs({
            fromIso: date_from,
            toIso: date_to,
            projectFilter: project_name ? { nameNeedle: project_name } : undefined,
          }),
          getTasks({ mineOnly: true, openOnly: false }).catch(() => [] as Task[]),
        ]);
        const { subject, days: attendance, available } = attendanceResult;

        if (!available) {
          return undetermined(
            {
              reason_code: "attendance_unavailable",
              message:
                `Zoho People returned no attendance records for ${subject.label}, so no ` +
                `shortfall can be computed.`,
            },
            { subject: subject.label },
          );
        }

        // Identity unknown: the "already logged" side would be everyone's.
        if (sweep.undetermined?.reason_code === "identity_unknown") {
          return undetermined(sweep.undetermined, { coverage: coverageView(sweep.coverage) });
        }

        // No project to read: the timesheet side is unknown for every day.
        // Attendance is still real, so the plan is returned with the logged
        // side marked unknown rather than assumed empty.
        const timesheetUnreadable = Boolean(sweep.undetermined);
        const perDay = rollUpDays(days, sweep.logs, sweep.coverage);
        const loggedByDay = new Map(perDay.map((d) => [d.date, d]));
        const complete = sweep.coverage.covers_whole_timesheet;

        const plan = attendance.map((a) => {
          const day = loggedByDay.get(a.date);
          // Hours found are real wherever they were found; what a partial read
          // cannot promise is that there are no OTHERS. So the logged side is
          // a lower bound and the shortfall an upper bound, both labelled.
          const logged = timesheetUnreadable ? null : (day?.hours ?? 0);
          // Never negative: having logged MORE than attendance is a real
          // situation (offline work), and it means nothing is owed, not that
          // hours should be removed.
          const shortfall = logged === null ? null : Math.max(0, a.hours - logged);
          // "Confirmed" means this figure is the whole story for the day, which
          // needs the read to have covered the whole timesheet — finding SOME
          // hours does not rule out more in a project that was never read.
          const confirmed = !timesheetUnreadable && complete && day?.logged !== null;
          return {
            date: a.date,
            check_in: a.checkIn,
            check_out: a.checkOut,
            attendance_hours: a.hours,
            attendance_status: a.status,
            already_logged_hours: logged === null ? null : Number(logged.toFixed(2)),
            /** False when more time may already be logged somewhere unread. */
            already_logged_is_confirmed: confirmed,
            hours_to_log: shortfall === null ? null : Number(shortfall.toFixed(2)),
            /** True only when the shortfall is certain; null when it is a maximum. */
            needs_task: shortfall === null ? null : confirmed ? shortfall > 0 : null,
            safe_to_file_without_asking: confirmed && shortfall !== null && shortfall > 0,
          };
        });

        const fillable = plan.filter((d) => (d.hours_to_log ?? 0) > 0);
        const unconfirmed = plan.filter(
          (d) => d.attendance_hours > 0 && !d.already_logged_is_confirmed,
        );
        const unknownDays = plan.filter((d) => d.hours_to_log === null && d.attendance_hours > 0);
        const owed = fillable.reduce((a, d) => a + (d.hours_to_log ?? 0), 0);

        const lines: string[] = [];
        if (fillable.length) {
          lines.push(
            `Up to ${owed.toFixed(2)}h of attendance appears not to be on the timesheet, across ` +
              `${fillable.length} day(s): ` +
              `${fillable.map((d) => `${d.date} (${d.hours_to_log}h)`).join(", ")}.`,
          );
        }
        if (unknownDays.length) {
          lines.push(
            `For ${unknownDays.length} day(s) the timesheet could NOT be read at all ` +
              `(${unknownDays.map((d) => d.date).join(", ")}): ` +
              (sweep.undetermined ? sweep.undetermined.message : "see timesheet_coverage.") +
              ` Their hours_to_log is null. Do not file for them.`,
          );
        }
        if (unconfirmed.length && !timesheetUnreadable) {
          lines.push(
            `IMPORTANT: the shortfalls above are a MAXIMUM, not a fact. ` +
              (coverageCaveat(sweep.coverage) || "") +
              ` Time already logged in a project that was not read would not show here, so ` +
              `filing these hours could duplicate entries. Ask the user to confirm each day ` +
              `before calling log_time, or re-run with project_name to check a specific project.`,
          );
        }
        if (!fillable.length && !unknownDays.length) {
          lines.push(
            complete
              ? `Attendance for ${date_from} → ${date_to} is already fully reflected on the ` +
                `timesheet. Nothing to file.`
              : `No shortfall was found in the projects that could be read for ` +
                `${date_from} → ${date_to}. Nothing to file.`,
          );
        }
        lines.push(
          `Nothing has been written. Ask the user which task each day belongs to — attendance ` +
            `cannot tell you — then call log_time once per day with the chosen task_id, the ` +
            `date, and hours_to_log.`,
        );

        return ok(lines.join("\n\n"), {
          wrote_to_zoho: false,
          subject: subject.label,
          /** An upper bound unless already_logged_is_complete is true. */
          hours_to_log_total: Number(owed.toFixed(2)),
          already_logged_is_complete: complete && !timesheetUnreadable,
          days_timesheet_unknown: unknownDays.map((d) => d.date),
          days_shortfall_unconfirmed: unconfirmed.map((d) => d.date),
          per_day: plan,
          timesheet_coverage: coverageView(sweep.coverage),
          your_tasks: tasks.map(taskView),
        });
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
          .describe(
            "Match against other people's tasks too, not just this user's. Riskier, and on a " +
              "large portal it needs project_name.",
          ),
        project_name: z
          .string()
          .optional()
          .describe("With include_others, the project(s) whose tasks to match against."),
      },
    },
    async ({
      conversations_json,
      min_minutes,
      round_to_minutes,
      utc_offset_minutes,
      include_others,
      project_name,
    }) =>
      guarded(async () => {
        const conversations = parseOmiConversations(conversations_json, utc_offset_minutes);
        if (conversations.length === 0) {
          return ok("That export contained no conversations. Nothing to propose.", { drafts: [] });
        }

        // Closed tasks included for the same reason as log_time: a day's work
        // is routinely logged against a task that was closed the moment it
        // was done.
        const tasks = await getTasks({
          mineOnly: !include_others,
          openOnly: false,
          projectName: project_name,
        });
        if (tasks.length === 0) {
          return fail(
            `No Zoho tasks are available to match against, so no drafts could be built. ` +
              `This server is acting as ${actingAs()} — run whoami to confirm that is the ` +
              `right account, or retry with include_others:true and project_name (at most ` +
              `${PROJECT_SWEEP_CAP} projects may match).`,
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
