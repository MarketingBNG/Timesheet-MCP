import { config } from "./config.js";
import { getAccessToken, invalidateAndRefresh } from "./auth.js";
import { describeZohoError, ZohoError } from "./errors.js";
import { log } from "./logger.js";
import { fromPortalDate, hhmmToHours, toPortalDate } from "./format.js";
import { effective } from "./context.js";

/* ------------------------------------------------------------------ *
 * Concurrency limiter — Zoho's per-minute quotas are small, and the
 * task sweep would otherwise fire a burst wide enough to trip them.
 * ------------------------------------------------------------------ */
let active = 0;
const queue: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= config.maxConcurrency) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = queue.shift();
    if (next) next();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The REST API takes MM-dd-yyyy on timelog endpoints regardless of the
 * portal's own display format (this portal shows dd/MM/yyyy and still requires
 * MM-dd-yyyy over the API). Verified against the live portal.
 */
export const API_DATE_FORMAT = "MM-dd-yyyy";

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | undefined>;
  form?: Record<string, string | number | undefined>;
  /** Internal: prevents infinite auth-retry recursion. */
  _retriedAuth?: boolean;
  _rateLimitAttempt?: number;
}

/** Portal-scoped path, e.g. "tasks/" -> /restapi/portal/{id}/tasks/ */
function portalUrl(path: string, query?: RequestOptions["query"]): string {
  const clean = path.replace(/^\/+/, "");
  const url = new URL(`${config.apiBase}/portal/${effective().portalId}/${clean}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const url = path.startsWith("http") ? path : portalUrl(path, opts.query);

  const run = async (): Promise<T> => {
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Zoho-oauthtoken ${token}`,
      Accept: "application/json",
    };

    let body: string | undefined;
    if (opts.form) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) {
        if (v !== undefined && v !== "") form.set(k, String(v));
      }
      body = form.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    log.debug(`${method} ${url}`, opts.form ? { form: opts.form } : undefined);
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();

    if (res.status === 401 && !opts._retriedAuth) {
      log.warn("Zoho returned 401 — refreshing token and retrying once");
      await invalidateAndRefresh();
      return request<T>(path, { ...opts, _retriedAuth: true });
    }

    if (res.status === 429) {
      const attempt = opts._rateLimitAttempt ?? 0;
      if (attempt < 3) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2000 * 2 ** attempt;
        log.warn(`rate limited by Zoho, waiting ${waitMs}ms (attempt ${attempt + 1}/3)`);
        await sleep(waitMs);
        return request<T>(path, { ...opts, _rateLimitAttempt: attempt + 1 });
      }
    }

    if (!res.ok) throw describeZohoError(res.status, text);

    if (!text.trim()) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ZohoError(
        `Zoho returned a response that was not JSON (HTTP ${res.status}).`,
        res.status,
        undefined,
        text.slice(0, 200),
      );
    }
  };

  return withSlot(run);
}

/* ------------------------------------------------------------------ *
 * Portal metadata
 * ------------------------------------------------------------------ */

const portalMetaCache = new Map<string, Promise<{ dateFormat: string; name: string }>>();

/**
 * The portal's configured date format, e.g. "MM-dd-yyyy". Every date we send
 * or read is converted through this. Fetched once and memoised.
 */
export function getPortalMeta(): Promise<{ dateFormat: string; name: string }> {
  const portalId = effective().portalId;
  const cached = portalMetaCache.get(portalId);
  if (cached) return cached;

  const pending = (async () => {
    try {
      const json = await request<any>(`${config.apiBase}/portals/`);
      const portals: any[] = json.portals ?? [];
      const mine =
        portals.find((p) => String(p.id_string ?? p.id) === String(portalId)) ?? portals[0];
      const raw: string =
        mine?.settings?.date_format ?? mine?.settings?.task_date_format ?? mine?.date_format ??
        "MM-dd-yyyy";

      // Portals report a combined date+time pattern ("dd/MM/yyyy hh:mm aaa").
      // Timelogs take a bare date, so drop everything from the time tokens on.
      const dateOnly = raw.split(/\s+(?=[hHmsaAkK])/)[0].trim();

      // Only the purely numeric variants are convertible; fall back otherwise.
      const numeric =
        /yyyy/i.test(dateOnly) && /dd/.test(dateOnly) && /MM/.test(dateOnly) &&
        !/MMM/.test(dateOnly);
      const dateFormat = numeric ? dateOnly : "MM-dd-yyyy";
      log.info(`portal date format: ${dateFormat} (reported: ${raw})`);
      return { dateFormat, name: String(mine?.name ?? portalId) };
    } catch (err) {
      log.warn("could not read portal settings, defaulting to MM-dd-yyyy", String(err));
      return { dateFormat: "MM-dd-yyyy", name: String(portalId) };
    }
  })();

  portalMetaCache.set(portalId, pending);
  return pending;
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

export interface Project {
  project_id: string;
  project_name: string;
  status: string;
}

export async function listProjects(activeOnly = true): Promise<Project[]> {
  const out: Project[] = [];
  let index = 1;
  const range = 200;

  for (;;) {
    const json = await request<any>("projects/", {
      query: { index, range, status: activeOnly ? "active" : "all" },
    });
    const batch: any[] = json.projects ?? [];
    for (const p of batch) {
      out.push({
        project_id: String(p.id_string ?? p.id),
        project_name: String(p.name ?? ""),
        status: String(p.status ?? ""),
      });
    }
    if (batch.length < range) break;
    index += range;
    if (index > 2000) break; // safety valve
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Tasks — portal-wide endpoint: one call per page, not one per project
 * ------------------------------------------------------------------ */

export interface Task {
  task_id: string;
  task_name: string;
  project_id: string;
  project_name: string;
  status: string;
  completed: boolean;
  owner_ids: string[];
  /** Full owner records — the only place a Team Member can see both id spaces. */
  owners: TaskOwner[];
  last_updated?: string;
}

export interface TaskOwner {
  zpuid: string;
  /** The 600... id that timelogs are stamped with. */
  portalUserId: string;
  email: string;
  name: string;
}

interface TaskCache {
  fetchedAt: number;
  tasks: Task[];
}

/** Per-portal, so one user's cache is never served to another. */
const taskCaches = new Map<string, TaskCache>();

export function clearTaskCache(): void {
  const portalId = effective().portalId;
  taskCaches.delete(`${portalId}:mine`);
  taskCaches.delete(`${portalId}:all`);
}

export interface TaskQuery {
  /** Only tasks owned by the configured ZOHO_USER_ID. Default true. */
  mineOnly?: boolean;
  /** Exclude completed/closed tasks. Default true. */
  openOnly?: boolean;
  /** Case-insensitive substring filter on project name. */
  projectName?: string;
  /** Bypass the in-memory cache. */
  forceRefresh?: boolean;
}

/**
 * Max projects swept for tasks. Only used for the include_others path -- the
 * default path uses /mytasks/, which is a single call. Kept small because
 * Zoho throttles at 100 requests per endpoint per 2 minutes, and portals can
 * expose tens of thousands of projects.
 */
const PROJECT_SWEEP_CAP = Number(process.env.PROJECT_SWEEP_CAP ?? 20);

/** Thrown to abort a sweep the moment Zoho starts throttling. */
class ThrottledError extends Error {}

function isThrottle(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /THROTTLE|more than \d+ requests/i.test(text);
}

/**
 * Tasks assigned to the caller, in ONE request.
 *
 * This endpoint is what makes the server usable on a large portal. The
 * per-project sweep below issues one request per project, which on a portal
 * exposing tens of thousands of projects trips Zoho's rolling throttle (100
 * requests per endpoint per 2 minutes) and locks the account out for half an
 * hour. Returns 204 with an empty body when the user has no tasks.
 */
async function fetchMyTasks(): Promise<Task[]> {
  const out: Task[] = [];
  let index = 1;
  const range = 200;

  for (;;) {
    const json = await request<any>("mytasks/", { query: { index, range } });
    const batch: any[] = json.tasks ?? [];
    for (const t of batch) out.push(toTask(t, ""));
    if (batch.length < range) break;
    index += range;
    if (index > 2000) break;
  }
  return out;
}

/**
 * Every task the account can see, gathered per project. Expensive and capped;
 * only used when explicitly asking for other people's tasks.
 */
async function fetchAllTasks(): Promise<Task[]> {
  const projects = await listProjects(true);

  if (projects.length > PROJECT_SWEEP_CAP) {
    log.warn(
      `account can see ${projects.length} projects; only sweeping the first ` +
        `${PROJECT_SWEEP_CAP} for tasks. Use project_name to target the rest.`,
    );
  }

  const targets = projects.slice(0, PROJECT_SWEEP_CAP);
  try {
    const batches = await Promise.all(
      targets.map((p) => fetchProjectTasks(p.project_id, p.project_name)),
    );
    return batches.flat();
  } catch (err) {
    if (err instanceof ThrottledError) {
      throw new ZohoError(
        "Zoho throttled the request while scanning projects for tasks.",
        429,
        undefined,
        "This portal exposes too many projects to scan. Use get_my_tasks without " +
          "include_others, or narrow it with project_name.",
      );
    }
    throw err;
  }
}

/** Map one Zoho task row onto our shape. */
function toTask(t: any, projectName: string, projectId = ""): Task {
  const owners: any[] = t.details?.owners ?? t.owners ?? [];
  const statusName = String(t.status?.name ?? t.status ?? "");

  return {
    task_id: String(t.id_string ?? t.id),
    task_name: String(t.name ?? ""),
    project_id: String(t.project?.id_string ?? t.project?.id ?? projectId),
    project_name: String(t.project?.name || projectName),
    status: statusName,
    completed:
      t.completed === true ||
      String(t.status?.type ?? "").toLowerCase() === "closed" ||
      /^(closed|completed|done)$/i.test(statusName),
    owner_ids: owners
      .flatMap((o) => [o.zpuid, o.id, o.owner_id])
      .map((v) => String(v ?? ""))
      .filter(Boolean),
    owners: owners.map((o) => ({
      zpuid: String(o.zpuid ?? ""),
      portalUserId: String(o.id ?? o.owner_id ?? ""),
      email: String(o.email ?? ""),
      name: String(o.full_name ?? o.name ?? ""),
    })),
    last_updated: t.last_updated_time ?? t.created_time,
  };
}

async function fetchProjectTasks(projectId: string, projectName: string): Promise<Task[]> {
  const out: Task[] = [];
  let index = 1;
  const range = 200;

  for (;;) {
    let json: any;
    try {
      json = await request<any>(`projects/${projectId}/tasks/`, { query: { index, range } });
    } catch (err) {
      // A throttle affects every subsequent call, so stop the whole sweep
      // rather than burning the remaining quota one project at a time.
      if (isThrottle(err)) throw new ThrottledError(String(err));
      // One inaccessible project must not sink the whole task list.
      log.warn(`skipping tasks for project ${projectId}`, String(err));
      break;
    }
    const batch: any[] = json.tasks ?? [];
    for (const t of batch) out.push(toTask(t, projectName, projectId));
    if (batch.length < range) break;
    index += range;
    if (index > 2000) break; // safety valve
  }
  return out;
}

export async function getTasks(query: TaskQuery = {}): Promise<Task[]> {
  const { mineOnly = true, openOnly = true, projectName, forceRefresh = false } = query;

  const { portalId, userId, label } = effective();
  const cacheKey = `${portalId}:${mineOnly ? "mine" : "all"}`;
  const cached = taskCaches.get(cacheKey);
  const fresh =
    cached !== undefined &&
    Date.now() - cached.fetchedAt < config.taskCacheTtlSeconds * 1000;

  if (!fresh || forceRefresh) {
    // One request when we only need the caller's own tasks; a capped sweep
    // only when explicitly asked for everyone's.
    const fetched = mineOnly ? await fetchMyTasks() : await fetchAllTasks();
    taskCaches.set(cacheKey, { fetchedAt: Date.now(), tasks: fetched });
    log.info(`fetched ${fetched.length} tasks for ${label}`);
  }

  let tasks = taskCaches.get(cacheKey)!.tasks;
  // /mytasks/ is already scoped to the caller, so no owner filter is applied
  // there -- applying one would wrongly drop everything when the two id
  // spaces disagree, which they do on some portals.
  if (!mineOnly && userId) tasks = tasks.filter((t) => t.owner_ids.includes(userId));
  if (openOnly) tasks = tasks.filter((t) => !t.completed);
  if (projectName) {
    const needle = projectName.toLowerCase();
    tasks = tasks.filter((t) => t.project_name.toLowerCase().includes(needle));
  }
  return tasks;
}

/**
 * Find a user's portal user id (600...) by scanning task owner records.
 *
 * The /users/ endpoint returns 6401 for anyone who is not a portal admin, so
 * for most people this is the only readable source that carries both id
 * spaces. Works for anyone who owns at least one task — which is exactly the
 * population that logs time.
 */
export async function resolveIdentityFromTasks(): Promise<TaskOwner | null> {
  const tasks = await getTasks({ mineOnly: true, openOnly: false });
  if (tasks.length === 0) return null;

  // Every task /mytasks/ returns is one the caller owns, so the caller is the
  // owner common to all of them. Intersecting is what makes this work when a
  // task has several owners.
  let common: TaskOwner[] | null = null;
  for (const task of tasks) {
    if (task.owners.length === 0) continue;
    if (common === null) {
      common = [...task.owners];
    } else {
      common = common.filter((c) =>
        task.owners.some((o) => o.portalUserId === c.portalUserId),
      );
    }
    if (common.length === 1) break;
  }

  if (!common || common.length === 0) return null;

  if (common.length > 1) {
    log.warn(
      `could not single out the caller: ${common.length} owners appear on every task`,
    );
    return null;
  }

  return common[0].portalUserId ? common[0] : null;
}

export async function getTaskById(taskId: string): Promise<Task | null> {
  const all = await getTasks({ mineOnly: false, openOnly: false });
  return all.find((t) => t.task_id === String(taskId)) ?? null;
}

export interface CreateTaskInput {
  projectId: string;
  name: string;
  /** zpuid values. Defaults to the configured user, i.e. assign to self. */
  ownerIds?: string[];
  startIso?: string;
  endIso?: string;
  description?: string;
  priority?: string;
}

/**
 * Create a task, by default assigned to the configured user. Exists so a
 * team member can give themselves something to log time against without
 * waiting on a portal admin.
 */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  // Passing person_responsible with our own zpuid is rejected as "user does
  // not belong to this project" on portals where the id spaces differ.
  // Omitting it makes Zoho assign the task to the caller, which is what
  // "create a task for myself" means anyway.
  const explicitOwners = input.ownerIds?.length ? input.ownerIds : undefined;

  const json = await request<any>(`projects/${input.projectId}/tasks/`, {
    method: "POST",
    form: {
      name: input.name,
      person_responsible: explicitOwners?.join(","),
      start_date: input.startIso ? toPortalDate(input.startIso, API_DATE_FORMAT) : undefined,
      end_date: input.endIso ? toPortalDate(input.endIso, API_DATE_FORMAT) : undefined,
      description: input.description,
      priority: input.priority,
    },
  });

  const raw = json.tasks?.[0] ?? json.task ?? json;
  // The new task must be visible to the very next log_time call.
  clearTaskCache();

  // Read the owners back rather than assuming: this is how a user with no
  // prior tasks discovers their own portal user id.
  const rawOwners: any[] = raw?.details?.owners ?? raw?.owners ?? [];
  const owners: TaskOwner[] = rawOwners.map((o) => ({
    zpuid: String(o.zpuid ?? ""),
    portalUserId: String(o.id ?? o.owner_id ?? ""),
    email: String(o.email ?? ""),
    name: String(o.full_name ?? o.name ?? ""),
  }));

  return {
    task_id: String(raw?.id_string ?? raw?.id ?? ""),
    task_name: String(raw?.name ?? input.name),
    project_id: String(raw?.project?.id_string ?? raw?.project?.id ?? input.projectId),
    project_name: String(raw?.project?.name ?? ""),
    status: String(raw?.status?.name ?? raw?.status ?? "Open"),
    completed: false,
    owner_ids: owners.flatMap((o) => [o.zpuid, o.portalUserId]).filter(Boolean),
    owners,
  };
}

/* ------------------------------------------------------------------ *
 * Timelogs
 * ------------------------------------------------------------------ */

export interface TimeLog {
  log_id: string;
  task_id?: string;
  task_name?: string;
  project_id?: string;
  project_name?: string;
  date: string; // ISO YYYY-MM-DD
  hours: number; // decimal
  hours_display: string; // HH:MM
  notes: string;
  bill_status: string;
  owner_id: string;
  owner_name: string;
}

export interface CreateLogInput {
  projectId: string;
  taskId: string;
  isoDate: string;
  hoursHHMM: string;
  notes?: string;
  billStatus: string;
}

export async function createTimeLog(input: CreateLogInput): Promise<TimeLog> {
  const dateFormat = API_DATE_FORMAT;
  const json = await request<any>(
    `projects/${input.projectId}/tasks/${input.taskId}/logs/`,
    {
      method: "POST",
      form: {
        date: toPortalDate(input.isoDate, dateFormat),
        bill_status: input.billStatus,
        hours: input.hoursHHMM,
        notes: input.notes ?? "",
        // No `owner`: it expects the portal user id (600...), not the zpuid,
        // and omitting it makes Zoho attribute the log to the token's own
        // user, which is what we want anyway.
      },
    },
  );

  const raw = json.timelogs?.tasklogs?.[0] ?? json.tasklogs?.[0] ?? json;
  return normaliseLog(raw, dateFormat, input.isoDate);
}

export async function deleteTimeLog(
  projectId: string,
  taskId: string,
  logId: string,
): Promise<void> {
  await request(`projects/${projectId}/tasks/${taskId}/logs/${logId}/`, {
    method: "DELETE",
  });
}

export interface LogQuery {
  fromIso: string;
  toIso: string;
  /** Defaults to the configured user; pass "all" for the whole portal. */
  users?: string;
}

/** First day of each month touched by the range, as MM-dd-yyyy. */
function monthsSpanning(fromIso: string, toIso: string): string[] {
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
  return out;
}

/**
 * This portal exposes timelogs only per project, and rejects view_type
 * custom_date — so the range is covered with one month-view call per project
 * per month, then filtered client-side. Both verified against the live API.
 */
export async function listTimeLogs(query: LogQuery): Promise<TimeLog[]> {
  const ownerFilter = query.users ?? effective().timelogOwnerId;

  // Driven by the caller's own tasks rather than by projects. Portals here
  // expose thousands of projects, so enumerating them both misses most logs
  // and trips Zoho's throttle; a person's own tasks are a handful.
  const tasks = await getTasks({ mineOnly: true, openOnly: false });

  if (tasks.length > 0) {
    const targets = tasks.slice(0, TASK_LOG_SCAN_CAP);
    if (tasks.length > targets.length) {
      log.warn(
        `scanning logs for the first ${targets.length} of ${tasks.length} tasks`,
      );
    }

    const batches = await Promise.all(
      targets.map((t) => fetchTaskLogs(t).catch(() => [] as TimeLog[])),
    );

    return batches
      .flat()
      .filter((l) => l.date >= query.fromIso && l.date <= query.toIso)
      .filter((l) => !ownerFilter || ownerFilter === "all" || l.owner_id === ownerFilter);
  }

  // No tasks of their own: fall back to a capped project scan so the tool
  // still answers rather than returning a bare zero.
  const projects = (await listProjects(true)).slice(0, PROJECT_SWEEP_CAP);
  const months = monthsSpanning(query.fromIso, query.toIso);
  const calls: Array<Promise<TimeLog[]>> = [];
  for (const project of projects) {
    for (const month of months) calls.push(fetchProjectMonthLogs(project, month));
  }

  return (await Promise.all(calls))
    .flat()
    .filter((l) => l.date >= query.fromIso && l.date <= query.toIso)
    .filter((l) => !ownerFilter || ownerFilter === "all" || l.owner_id === ownerFilter);
}

/** Max tasks whose logs are read for one timesheet query. */
const TASK_LOG_SCAN_CAP = Number(process.env.TASK_LOG_SCAN_CAP ?? 40);

/** Every timelog on one task. Cheap, and scoped to work the caller owns. */
async function fetchTaskLogs(task: Task): Promise<TimeLog[]> {
  const json = await request<any>(
    `projects/${task.project_id}/tasks/${task.task_id}/logs/`,
    { query: { index: 1, range: 200 } },
  );

  const out: TimeLog[] = [];
  const buckets: any[] = json.timelogs?.date ?? [];
  const flat: any[] = json.timelogs?.tasklogs ?? [];

  const push = (entry: any, bucketDate?: string) => {
    const log = normaliseLog(entry, API_DATE_FORMAT, undefined, bucketDate);
    out.push({
      ...log,
      task_id: log.task_id ?? task.task_id,
      task_name: log.task_name ?? task.task_name,
      project_id: log.project_id ?? task.project_id,
      project_name: log.project_name ?? task.project_name,
    });
  };

  for (const bucket of buckets) {
    for (const entry of bucket.tasklogs ?? []) push(entry, bucket.date);
  }
  for (const entry of flat) push(entry);

  return out;
}

async function fetchProjectMonthLogs(
  project: Project,
  monthDate: string,
): Promise<TimeLog[]> {
  let json: any;
  try {
    json = await request<any>(`projects/${project.project_id}/logs/`, {
      query: {
        users_list: "all",
        view_type: "month",
        date: monthDate,
        bill_status: "All",
        component_type: "task",
        index: 1,
        range: 200,
      },
    });
  } catch (err) {
    log.warn(`skipping logs for project ${project.project_id} @ ${monthDate}`, String(err));
    return [];
  }

  const out: TimeLog[] = [];
  for (const bucket of (json.timelogs?.date ?? []) as any[]) {
    const entries = [
      ...(bucket.tasklogs ?? []),
      ...(bucket.buglogs ?? []),
      ...(bucket.generallogs ?? []),
    ];
    for (const entry of entries) {
      const t = normaliseLog(entry, API_DATE_FORMAT, undefined, bucket.date);
      out.push({
        ...t,
        project_id: t.project_id ?? project.project_id,
        project_name: t.project_name ?? project.project_name,
      });
    }
  }
  return out;
}

function normaliseLog(
  raw: any,
  dateFormat: string,
  knownIso?: string,
  bucketDate?: string,
): TimeLog {
  const rawDate = raw?.log_date ?? raw?.date ?? bucketDate ?? "";
  const iso = knownIso ?? fromPortalDate(String(rawDate), dateFormat) ?? String(rawDate);
  const display = String(raw?.hours_display ?? raw?.hours ?? "00:00");

  const idOf = (o: any) =>
    o?.id_string !== undefined
      ? String(o.id_string)
      : o?.id !== undefined
        ? String(o.id)
        : undefined;

  return {
    log_id: String(raw?.id_string ?? raw?.id ?? ""),
    task_id: idOf(raw?.task),
    task_name: raw?.task?.name,
    project_id: idOf(raw?.project),
    project_name: raw?.project?.name,
    date: iso,
    // Zoho reports `hours` as whole hours only (a 15-minute log comes back as
    // 0), so the HH:MM display string is the authoritative duration.
    hours: hhmmToHours(display) || Number(raw?.hours ?? 0),
    hours_display: display,
    notes: String(raw?.notes ?? ""),
    bill_status: String(raw?.bill_status ?? ""),
    owner_id: String(raw?.owner_id ?? raw?.owner ?? ""),
    owner_name: String(raw?.owner_name ?? ""),
  };
}
