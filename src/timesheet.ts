import { projectsFromAuditFile } from "./audit.js";
import { currentUser, discoveries, effective } from "./context.js";
import { ZohoError } from "./errors.js";
import { log } from "./logger.js";
import {
  dedupeLogs,
  ensureCallerUserId,
  fetchProjectMonthLogs,
  fetchTaskLogs,
  getTasks,
  isThrottle,
  listActiveProjectsCached,
  ThrottledError,
  type LogComponent,
  type Task,
  type TimeLog,
} from "./zoho.js";

/**
 * Reading a person's timesheet back out of Zoho.
 *
 * Zoho exposes timelogs per project (and per task), never "everything this
 * user logged anywhere". So a read is a sweep over candidate projects, and the
 * honest output of a sweep is the hours it found PLUS a statement of where it
 * looked and where it could not. A zero that really means "did not look" was
 * the bug this module replaces: the previous implementation scanned the first
 * 20 of 349 projects for a user with no tasks and reported "0.00h logged".
 */

export interface ProjectRef {
  project_id: string;
  project_name: string;
}

export interface SweepInput {
  fromIso: string;
  toIso: string;
  /** Scope the sweep to particular projects instead of deriving the set. */
  projectFilter?: { ids?: string[]; nameNeedle?: string };
}

export interface CoverageFailure {
  project_id: string;
  project_name: string;
  month: string;
  component: string;
  error: string;
}

export interface Coverage {
  /** How the project set was chosen: own_tasks | connector_writes | all_projects | explicit. */
  basis: string[];
  /**
   * True only when this read covered EVERY project the caller can see, for
   * every month in the range, with no failures. Only then can a day with no
   * hours be called empty; otherwise the absence just means "not found where
   * we looked".
   */
  covers_whole_timesheet: boolean;
  /** Why it does not, in words, when it does not. */
  incomplete_because: string[];
  projects_scanned: ProjectRef[];
  /** Candidate projects that were never read (budget, time or throttle). */
  projects_unscanned: ProjectRef[];
  /** Active projects the caller can see, when that was looked up. */
  projects_visible: number | null;
  /** Months the range touches, YYYY-MM. */
  months: string[];
  /** Months in which at least one project/component read failed or was skipped. */
  months_unknown: string[];
  components: LogComponent[];
  failures: CoverageFailure[];
  throttled: boolean;
  /** True when the request budget or the time limit cut the sweep short. */
  truncated: boolean;
  /** Calls that had to read everyone's logs and filter to the caller client-side. */
  users_list_fallbacks: number;
  requests: number;
  own_task_check?: {
    tasks_checked: number;
    tasks_total: number;
    /** Entries the per-task read found that the project view had not returned. */
    extra_logs_found: number;
  };
}

export interface Undetermined {
  reason_code: "identity_unknown" | "no_projects_to_scan" | "too_many_projects";
  message: string;
}

export interface SweepResult {
  logs: TimeLog[];
  coverage: Coverage;
  undetermined?: Undetermined;
}

/** Requests one sweep may spend. Zoho allows ~100 per endpoint per 2 minutes. */
export const SWEEP_REQUEST_BUDGET = Number(process.env.TIMESHEET_REQUEST_BUDGET ?? 60);
/** Wall-clock limit for one sweep; MCP clients time out well before Zoho does. */
const SWEEP_TIMEOUT_MS = Number(process.env.TIMESHEET_SWEEP_TIMEOUT_MS ?? 40_000);
/** Own tasks re-read directly as a cross-check on the project view. */
const CROSSCHECK_TASKS = Number(process.env.TIMESHEET_CROSSCHECK_TASKS ?? 12);
/** Remembered projects considered per sweep, most recently written first. */
export const REMEMBERED_PROJECT_LIMIT = 15;
const SWEEP_CONCURRENCY = 3;

/**
  * Every kind of Zoho time log. Reading only task logs was how a day whose
  * hours sat on a general or issue log came back looking empty.
  */
const COMPONENTS: LogComponent[] = ["task", "general", "bug"];

/** First day of each month touched by the range, as MM-01-yyyy, latest first. */
export function monthsSpanning(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const [fy, fm] = fromIso.split("-").map(Number);
  const [ty, tm] = toIso.split("-").map(Number);
  let y = fy;
  let m = fm;
  for (let guard = 0; guard < 120; guard++) {
    out.push(`${String(m).padStart(2, "0")}-01-${y}`);
    if (y === ty && m === tm) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out.reverse();
}

/** "MM-01-yyyy" -> "yyyy-MM" */
function monthKey(monthDate: string): string {
  const [mm, , yyyy] = monthDate.split("-");
  return `${yyyy}-${mm}`;
}

/* ------------------------------------------------------------------ *
 * Remembered projects — where this connector has written for the caller
 * ------------------------------------------------------------------ */

/** Service-account memory: seeded from the audit file, extended by writes. */
const serviceProjects = new Map<string, string>();
let serviceSeeded = false;

/** Test hook: forget the service account's remembered projects. */
export function resetForTests(): void {
  serviceProjects.clear();
  serviceSeeded = false;
}

function seedServiceProjects(): void {
  if (serviceSeeded) return;
  serviceSeeded = true;
  for (const [id, name] of projectsFromAuditFile()) serviceProjects.set(id, name);
  if (serviceProjects.size > 0) {
    log.info(`remembered ${serviceProjects.size} project(s) from the audit file`);
  }
}

/**
 * Projects the caller is known to have written to: persisted ones (loaded by
 * the HTTP layer onto the context, or from the audit file for a service
 * account) plus anything written during this request.
 */
export function rememberedProjects(): ProjectRef[] {
  const out = new Map<string, string>();
  const user = currentUser();
  if (user) {
    for (const p of user.rememberedProjects ?? []) out.set(p.project_id, p.project_name);
  } else {
    seedServiceProjects();
    for (const [id, name] of serviceProjects) out.set(id, name);
  }
  for (const [id, name] of discoveries().projects) {
    if (!out.has(id) || (name && !out.get(id))) out.set(id, name);
    if (!user) serviceProjects.set(id, name);
  }
  return [...out].map(([project_id, project_name]) => ({ project_id, project_name }));
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

interface SweepItem {
  project: ProjectRef;
  monthDate: string;
  component: LogComponent;
}

/** Errors on which reading everyone's logs and filtering would not help either. */
function isPermissionError(err: unknown): boolean {
  return err instanceof ZohoError && (err.status === 401 || err.status === 403);
}

export async function sweepTimeLogs(input: SweepInput): Promise<SweepResult> {
  // Reading a timesheet means separating one person's entries from everyone
  // else's, so resolve who that is before anything else rather than trusting
  // every caller to have done it.
  await ensureCallerUserId().catch((err) => {
    log.warn("could not resolve the caller's Zoho user id", String(err));
    return "";
  });

  const { timelogOwnerId: zuid, label } = effective();
  const months = monthsSpanning(input.fromIso, input.toIso);

  const coverage: Coverage = {
    basis: [],
    covers_whole_timesheet: false,
    incomplete_because: [],
    projects_scanned: [],
    projects_unscanned: [],
    projects_visible: null,
    months: months.map(monthKey),
    months_unknown: [],
    components: COMPONENTS,
    failures: [],
    throttled: false,
    truncated: false,
    users_list_fallbacks: 0,
    requests: 0,
  };

  if (!zuid) {
    return {
      logs: [],
      coverage,
      undetermined: {
        reason_code: "identity_unknown",
        message:
          `Cannot tell which Zoho user ${label} is, so their timesheet cannot be separated ` +
          `from everyone else's.`,
      },
    };
  }

  // ---- candidate projects --------------------------------------------------
  const candidates = new Map<string, ProjectRef>();
  const addAll = (refs: ProjectRef[], basis: string) => {
    let added = 0;
    for (const p of refs) {
      if (!p.project_id) continue;
      if (!candidates.has(p.project_id)) {
        candidates.set(p.project_id, p);
        added++;
      } else if (p.project_name && !candidates.get(p.project_id)!.project_name) {
        candidates.set(p.project_id, p);
      }
    }
    if (added > 0 && !coverage.basis.includes(basis)) coverage.basis.push(basis);
  };

  let ownTasks: Task[] = [];
  const perProjectCalls = months.length * COMPONENTS.length;

  if (input.projectFilter?.ids?.length || input.projectFilter?.nameNeedle) {
    const visible = await listActiveProjectsCached();
    coverage.projects_visible = visible.length;
    const byId = new Map(visible.map((p) => [p.project_id, p]));
    const refs: ProjectRef[] = [];
    for (const id of input.projectFilter.ids ?? []) {
      const known = byId.get(String(id));
      refs.push(known ?? { project_id: String(id), project_name: "" });
    }
    if (input.projectFilter.nameNeedle) {
      const needle = input.projectFilter.nameNeedle.trim().toLowerCase();
      refs.push(...visible.filter((p) => p.project_name.toLowerCase().includes(needle)));
    }
    addAll(refs, "explicit");
    coverage.incomplete_because.push(
      "the read was scoped to the project(s) you asked for, so time logged in any other " +
        "project is not counted",
    );
    if (candidates.size === 0) {
      return {
        logs: [],
        coverage,
        undetermined: {
          reason_code: "no_projects_to_scan",
          message:
            `No project matched the filter among the ${visible.length} active projects ` +
            `${label} can see. Run list_projects to see the exact names.`,
        },
      };
    }
    if (candidates.size * perProjectCalls > SWEEP_REQUEST_BUDGET) {
      return {
        logs: [],
        coverage,
        undetermined: {
          reason_code: "too_many_projects",
          message:
            `${candidates.size} projects match, which needs ${candidates.size * perProjectCalls} ` +
            `Zoho requests for this range; the limit per call is ${SWEEP_REQUEST_BUDGET}. ` +
            `Narrow project_name or the date range.`,
        },
      };
    }
  } else {
    try {
      ownTasks = await getTasks({ mineOnly: true, openOnly: false });
    } catch (err) {
      log.warn(`could not list own tasks for ${label}`, String(err));
    }
    const ownProjects = new Map<string, ProjectRef>();
    for (const t of ownTasks) {
      if (t.project_id && !ownProjects.has(t.project_id)) {
        ownProjects.set(t.project_id, { project_id: t.project_id, project_name: t.project_name });
      }
    }
    addAll([...ownProjects.values()], "own_tasks");
    addAll(rememberedProjects().slice(0, REMEMBERED_PROJECT_LIMIT), "connector_writes");

    // A small portal can simply be read in full, which is the only way to see
    // time logged on a colleague's task in a project we have no other link to.
    try {
      const visible = await listActiveProjectsCached();
      coverage.projects_visible = visible.length;
      const merged = new Set([...candidates.keys(), ...visible.map((p) => p.project_id)]);
      if (merged.size * perProjectCalls <= SWEEP_REQUEST_BUDGET) {
        addAll(visible, "all_projects");
        // Recorded even when it adds nothing new: the point is that the whole
        // visible portal is in scope, which is what lets a day with no hours be
        // called empty. addAll only labels a basis that contributed a project.
        if (!coverage.basis.includes("all_projects")) coverage.basis.push("all_projects");
      } else {
        // The portal is too large to read blind. Whatever is found is real,
        // but an empty day cannot be called empty — this is exactly how the
        // original "0.00h logged" was produced.
        const unread = visible.filter((p) => !candidates.has(p.project_id));
        coverage.projects_unscanned.push(...unread);
        coverage.incomplete_because.push(
          `only ${candidates.size} of ${visible.length} visible projects could be read ` +
            `(the ones holding your tasks, plus any this connector has written to for you); ` +
            `time logged elsewhere is not counted`,
        );
      }
    } catch (err) {
      log.warn(`could not list projects for ${label}`, String(err));
      coverage.incomplete_because.push("the list of visible projects could not be read");
    }

    if (candidates.size === 0) {
      const visible = coverage.projects_visible;
      return {
        logs: [],
        coverage,
        undetermined: {
          reason_code: "no_projects_to_scan",
          message:
            `${label} owns no Zoho tasks and this connector has not written to any project ` +
            `for them, so there is nowhere to look` +
            (visible !== null
              ? `: the portal has ${visible} active projects, too many to read blind.`
              : ".") +
            ` Pass project_name to read a specific project, or get a task assigned to you.`,
        },
      };
    }
  }

  // ---- plan the calls: latest month first, own/remembered projects first ---
  const ordered = [...candidates.values()];
  const items: SweepItem[] = [];
  for (const monthDate of months) {
    for (const project of ordered) {
      for (const component of COMPONENTS) items.push({ project, monthDate, component });
    }
  }

  const budgeted = items.slice(0, SWEEP_REQUEST_BUDGET);
  const skipped = items.slice(SWEEP_REQUEST_BUDGET);
  if (skipped.length > 0) coverage.truncated = true;

  // ---- run -----------------------------------------------------------------
  const deadline = Date.now() + SWEEP_TIMEOUT_MS;
  let aborted = false;
  // Counts actual Zoho calls, not planned project-months: one project-month
  // can page several times and can be retried with a different user filter, so
  // budgeting items would let a sweep sail past Zoho's rate limit believing it
  // was well under it.
  let spent = 0;
  const spend = (): boolean => {
    if (aborted || spent >= SWEEP_REQUEST_BUDGET || Date.now() > deadline) return false;
    spent++;
    coverage.requests++;
    return true;
  };
  const found: TimeLog[] = [];
  /** Projects every planned read of which succeeded. */
  const succeeded = new Set<string>();
  /** Projects we issued at least one read for. */
  const attempted = new Set<string>();
  /** Projects with at least one failed or short read. */
  const attemptedButIncomplete = new Set<string>();
  const unknownMonths = new Set<string>(skipped.map((s) => monthKey(s.monthDate)));
  const untouched: SweepItem[] = [...skipped];

  const runItem = async (item: SweepItem): Promise<void> => {
    if (aborted || spent >= SWEEP_REQUEST_BUDGET || Date.now() > deadline) {
      // Whatever the reason, this read did not happen and the sweep is short.
      coverage.truncated = true;
      unknownMonths.add(monthKey(item.monthDate));
      untouched.push(item);
      return;
    }

    const base = {
      projectId: item.project.project_id,
      projectName: item.project.project_name,
      monthDate: item.monthDate,
      component: item.component,
      noRetryOnRateLimit: true,
    };

    try {
      let result: { logs: TimeLog[]; complete: boolean; requests: number };
      try {
        result = await fetchProjectMonthLogs({ ...base, usersList: zuid, beforeRequest: spend });
      } catch (err) {
        if (err instanceof ThrottledError || isThrottle(err)) throw err;
        if (isPermissionError(err)) throw err;
        // Zoho may not accept a user id in users_list on every portal. Read
        // everyone's for this one project-month and keep only the caller's.
        coverage.users_list_fallbacks++;
        result = await fetchProjectMonthLogs({ ...base, usersList: "all", beforeRequest: spend });
      }
      for (const l of result.logs) {
        if (l.owner_id === zuid && l.date >= input.fromIso && l.date <= input.toIso) found.push(l);
      }
      if (result.complete) {
        succeeded.add(item.project.project_id);
      } else {
        // The budget or the page limit stopped it part-way: real hours, but
        // not all of them.
        coverage.truncated = true;
        unknownMonths.add(monthKey(item.monthDate));
        attemptedButIncomplete.add(item.project.project_id);
      }
      attempted.add(item.project.project_id);
    } catch (err) {
      if (err instanceof ThrottledError || isThrottle(err)) {
        aborted = true;
        coverage.throttled = true;
      }
      unknownMonths.add(monthKey(item.monthDate));
      attempted.add(item.project.project_id);
      attemptedButIncomplete.add(item.project.project_id);
      coverage.failures.push({
        project_id: item.project.project_id,
        project_name: item.project.project_name,
        month: monthKey(item.monthDate),
        component: item.component,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < budgeted.length) {
      const item = budgeted[cursor++];
      await runItem(item);
    }
  };
  await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, worker));

  // ---- cross-check against the per-task view -------------------------------
  // The project view is what Zoho's own timesheet uses, but it has never been
  // compared against this portal for a full month. The per-task read has, so
  // a bounded sample of own tasks is read directly and any entry it finds
  // that the project view missed is both counted and reported.
  if (ownTasks.length > 0 && !aborted && CROSSCHECK_TASKS > 0) {
    const remaining = SWEEP_REQUEST_BUDGET - spent;
    const sample = [...ownTasks]
      .sort((a, b) => String(b.last_updated ?? "").localeCompare(String(a.last_updated ?? "")))
      .slice(0, Math.max(0, Math.min(CROSSCHECK_TASKS, remaining)));
    const seen = new Set(found.map((l) => l.log_id));
    let extra = 0;
    let checked = 0;
    for (const task of sample) {
      if (!spend()) break;
      try {
        const logs = await fetchTaskLogs(task);
        checked++;
        for (const l of logs) {
          if (l.owner_id !== zuid || l.date < input.fromIso || l.date > input.toIso) continue;
          if (!seen.has(l.log_id)) {
            extra++;
            seen.add(l.log_id);
            found.push(l);
          }
        }
      } catch (err) {
        if (isThrottle(err)) {
          coverage.throttled = true;
          break;
        }
        log.warn(`cross-check read failed for task ${task.task_id}`, String(err));
      }
    }
    coverage.own_task_check = {
      tasks_checked: checked,
      tasks_total: ownTasks.length,
      extra_logs_found: extra,
    };
    if (checked < ownTasks.length) {
      coverage.incomplete_because.push(
        `${ownTasks.length - checked} of your ${ownTasks.length} tasks were not read directly`,
      );
    }
    if (extra > 0) {
      log.warn(
        `project view missed ${extra} timelog(s) that the per-task read found for ${label}; ` +
          `they are counted, but the month view on this portal is not complete`,
      );
    }
  }

  // A project counts as scanned only when every read planned for it worked.
  // One that failed or was cut short belongs on the other list, not silently
  // in neither, or coverage would look self-consistent with a project missing.
  const fullyRead = (id: string) => succeeded.has(id) && !attemptedButIncomplete.has(id);
  coverage.projects_scanned = ordered.filter((p) => fullyRead(p.project_id));
  coverage.projects_unscanned.push(...ordered.filter((p) => !fullyRead(p.project_id)));
  coverage.months_unknown = [...unknownMonths].sort();

  if (coverage.throttled) coverage.incomplete_because.push("Zoho throttled the read part-way");
  if (coverage.truncated) {
    coverage.incomplete_because.push("the request budget or time limit cut the read short");
  }
  if (coverage.failures.length) {
    coverage.incomplete_because.push(`${coverage.failures.length} project-month read(s) failed`);
  }
  if (!coverage.basis.includes("all_projects") && !coverage.basis.includes("explicit")) {
    coverage.incomplete_because.push("only projects linked to you were read");
  }

  // "Covers the whole timesheet" has to be earned: every project the caller can
  // see, every month in the range, every component, and nothing that failed or
  // was cut short. Only then does "no hours found" mean "no hours logged".
  coverage.covers_whole_timesheet = coverage.incomplete_because.length === 0;

  return { logs: dedupeLogs(found), coverage };
}

/* ------------------------------------------------------------------ *
 * Per-day roll-up with an honest third state
 * ------------------------------------------------------------------ */

export interface DayTotal {
  date: string;
  /** Hours confirmed for the day. A lower bound when `logged` is null. */
  hours: number;
  /** true = time found, false = confirmed empty, null = could not be determined. */
  logged: boolean | null;
}

/**
 * Sum logs per day. A day in a month the sweep could not fully read is
 * `logged: null` unless time was actually found on it — a found entry is a
 * fact, an absence in an unread month is not.
 */
export function rollUpDays(days: string[], logs: TimeLog[], coverage: Coverage): DayTotal[] {
  const totals = new Map<string, number>(days.map((d) => [d, 0]));
  for (const l of logs) {
    if (totals.has(l.date)) totals.set(l.date, totals.get(l.date)! + l.hours);
  }
  const unknownMonth = new Set(coverage.months_unknown);
  return days.map((d) => {
    const hours = Number((totals.get(d) ?? 0).toFixed(2));
    // Hours found are a fact. Hours NOT found only mean the day is empty if
    // the read could have seen them all — which, given that Zoho serves logs
    // per project and bug logs are not read, is currently never true. So a
    // zero day is reported as undetermined rather than as "you logged
    // nothing", which is what made the original bug so damaging: it invited a
    // second entry on a day that was already filled.
    const logged: boolean | null =
      hours > 0 ? true : coverage.covers_whole_timesheet && !unknownMonth.has(d.slice(0, 7)) ? false : null;
    return { date: d, hours, logged };
  });
}
