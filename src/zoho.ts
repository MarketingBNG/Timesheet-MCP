import { config } from "./config.js";
import { getAccessToken, invalidateAndRefresh } from "./auth.js";
import { describeZohoError, ZohoError } from "./errors.js";
import { log } from "./logger.js";
import { fromPortalDate, hhmmToHours, toPortalDate } from "./format.js";
import { adoptCallerUserId, discoveries, effective } from "./context.js";

/* ------------------------------------------------------------------ *
 * Concurrency limiter — Zoho's per-minute quotas are small, and the
 * task sweep would otherwise fire a burst wide enough to trip them.
 * ------------------------------------------------------------------ */
let active = 0;
const queue: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= config.maxConcurrency) {
    // The slot is counted as taken at hand-off below, not here: a waiter
    // resumes a microtask after being resolved, and a fresh caller arriving in
    // that gap would otherwise see a free slot and take it too, putting more
    // requests in flight than the limit allows.
    await new Promise<void>((resolve) => queue.push(resolve));
  } else {
    active++;
  }
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next(); // hands this slot straight over; `active` stays as it is
    else active--;
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
  /**
   * Skip the 429 backoff. Zoho's throttle is a two-minute rolling window, so
   * for a bulk sweep retrying inside the same window only burns time; the
   * caller would rather stop and report partial coverage.
   */
  noRetryOnRateLimit?: boolean;
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

/** No Zoho call may hang indefinitely; a stuck one would hold a slot forever. */
const REQUEST_TIMEOUT_MS = Number(process.env.ZOHO_TIMEOUT_MS ?? 30_000);

const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * One Zoho request, with auth retry and rate-limit backoff.
 *
 * Retries happen INSIDE the single acquired slot. Recursing into the limiter
 * for a retry deadlocks: the outer call still holds its slot while the inner
 * one queues for a slot that will never free, so a burst of expired-token 401s
 * equal to the concurrency limit wedges the process permanently.
 */
async function request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";

  return withSlot(async () => {
    let retriedAuth = false;
    let rateLimitAttempt = 0;

    for (;;) {
      // Built per attempt: the portal id is context-dependent.
      const url = path.startsWith("http") ? path : portalUrl(path, opts.query);
      const token = await getAccessToken();

      const headers: Record<string, string> = {
        Authorization: `Zoho-oauthtoken ${token}`,
        Accept: "application/json",
      };

      let body: string | undefined;
      if (opts.form) {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.form)) {
          // `undefined` means "leave unchanged"; "" means "set to empty", so
          // only the former is skipped.
          if (v !== undefined) form.set(k, String(v));
        }
        body = form.toString();
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }

      log.debug(`${method} ${url}`, opts.form ? { form: opts.form } : undefined);

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        throw new ZohoError(
          timedOut
            ? `Zoho did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`
            : `Could not reach Zoho: ${err instanceof Error ? err.message : String(err)}`,
          undefined,
          undefined,
          timedOut ? "Try again; Zoho may be slow or the portal very large." : undefined,
        );
      }

      const text = await res.text();

      if (res.status === 401 && !retriedAuth) {
        log.warn("Zoho returned 401 — refreshing token and retrying once");
        retriedAuth = true;
        await invalidateAndRefresh();
        continue;
      }

      if (
        res.status === 429 &&
        !opts.noRetryOnRateLimit &&
        rateLimitAttempt < MAX_RATE_LIMIT_RETRIES
      ) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2000 * 2 ** rateLimitAttempt;
        rateLimitAttempt++;
        log.warn(
          `rate limited by Zoho, waiting ${waitMs}ms ` +
            `(attempt ${rateLimitAttempt}/${MAX_RATE_LIMIT_RETRIES})`,
        );
        await sleep(waitMs);
        continue;
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
    }
  });
}

/** Thrown to abort a sweep the moment Zoho starts throttling. */
export class ThrottledError extends Error {}

export function isThrottle(err: unknown): boolean {
  if (err instanceof ZohoError && err.status === 429) return true;
  const text = err instanceof Error ? err.message : String(err);
  return /THROTTLE|more than \d+ requests|rate limit/i.test(text);
}

/**
 * Zoho pages with index/range but does not document the largest range it
 * honours (200 in most reports, 100 in some), so a full page cannot be
 * recognised by "we got as many as we asked for".
 *
 * The cursor therefore advances by the number of rows actually RECEIVED, and a
 * page is the last one only when it is empty. Advancing by the requested range
 * instead would skip a whole page on any endpoint that caps below it: ask for
 * 200, get 100, jump to 201, and rows 101-200 are never read — silently, with
 * the loop terminating normally.
 */
export function hasMorePages(received: number, range: number): boolean {
  return received > 0 && received >= Math.min(range, 100);
}

/* ------------------------------------------------------------------ *
 * Portals and the caller's identity
 * ------------------------------------------------------------------ */

/**
 * GET /portals/ once per user. Besides the portal list it carries the
 * caller's own `login_id` — the Zoho user id that timelogs and task owner
 * records use — which no other endpoint hands a Team Member.
 */
const portalsCache = new Map<string, Promise<any>>();

function fetchPortals(): Promise<any> {
  const key = effective().refreshToken || "service";
  const cached = portalsCache.get(key);
  if (cached) return cached;

  const pending = request<any>(`${config.apiBase}/portals/`)
    .then((json) => {
      // A 200 carrying no login_id has not answered the question this cache
      // exists for. Caching it would freeze the caller as "unidentified" for
      // the life of the process: the retry the HTTP layer schedules would keep
      // re-reading the same useless response instead of asking Zoho again.
      if (!String(json?.login_id ?? "").trim()) portalsCache.delete(key);
      return json;
    })
    .catch((err) => {
      portalsCache.delete(key);
      throw err;
    });
  portalsCache.set(key, pending);
  return pending;
}

const portalMetaCache = new Map<string, Promise<{ dateFormat: string; name: string }>>();

/**
 * The portal's configured date format, e.g. "MM-dd-yyyy", and its name.
 * Fetched once per portal and memoised; failures are not cached.
 */
export function getPortalMeta(): Promise<{ dateFormat: string; name: string }> {
  const portalId = effective().portalId;
  const cached = portalMetaCache.get(portalId);
  if (cached) return cached;

  const pending = (async () => {
    try {
      const json = await fetchPortals();
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
      portalMetaCache.delete(portalId);
      log.warn("could not read portal settings, defaulting to MM-dd-yyyy", String(err));
      return { dateFormat: "MM-dd-yyyy", name: String(portalId) };
    }
  })();

  portalMetaCache.set(portalId, pending);
  return pending;
}

/**
 * The caller's Zoho user id as reported by /portals/ `login_id`.
 *
 * This is the 600... id (a ZUID on this data centre) that Zoho stamps on
 * timelogs as owner_id, puts on task owner records as `id`, and accepts as
 * person_responsible. It is bound to the token, so it cannot be confused with
 * a colleague's the way an id read off a task record can. Empty when Zoho did
 * not report one.
 */
export async function getLoginUserId(): Promise<string> {
  const json = await fetchPortals();
  const raw = json?.login_id ?? json?.login_user_id ?? "";
  const id = String(raw ?? "").trim();
  return /^\d{4,}$/.test(id) ? id : "";
}

/**
 * Make sure we know which Zoho user the caller is, resolving it from
 * /portals/ if the context or configuration does not already say. Returns ""
 * only when Zoho itself would not tell us.
 */
export async function ensureCallerUserId(): Promise<string> {
  const known = effective().timelogOwnerId;
  if (known) return known;

  let id = "";
  try {
    id = await getLoginUserId();
  } catch (err) {
    log.warn("could not read login_id from /portals/", String(err));
  }
  if (!id) return "";

  adoptCallerUserId(id, "login_id");
  log.info(`resolved caller user id ${id} from /portals/ login_id for ${effective().label}`);
  return id;
}

/** True when we know which Zoho user the current caller is. */
export function callerIsIdentified(): boolean {
  return Boolean(effective().timelogOwnerId);
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
    if (!hasMorePages(batch.length, range)) break;
    index += batch.length;
    if (index > PROJECT_PAGE_LIMIT) {
      log.warn(
        `project list truncated at ${out.length}; this account can see more. ` +
          `Anything derived from it is a partial view.`,
      );
      break;
    }
  }
  return out;
}

/** Hard stop on project paging. 10 pages of 200. */
const PROJECT_PAGE_LIMIT = 2000;

interface ProjectCache {
  fetchedAt: number;
  projects: Project[];
}

const projectCaches = new Map<string, ProjectCache>();

/**
 * The active project list, cached per user for TASK_CACHE_TTL_SECONDS. The
 * timesheet sweep and whoami both want it, and on a portal with hundreds of
 * projects it is two requests every time.
 */
export async function listActiveProjectsCached(forceRefresh = false): Promise<Project[]> {
  const { portalId, userId } = effective();
  const key = `${portalId}:${userId}:projects`;
  const cached = projectCaches.get(key);
  const fresh =
    cached !== undefined &&
    Date.now() - cached.fetchedAt < config.taskCacheTtlSeconds * 1000;
  if (fresh && !forceRefresh) return cached!.projects;

  const projects = await listProjects(true);
  projectCaches.set(key, { fetchedAt: Date.now(), projects });
  return projects;
}

/**
 * Note that the caller wrote to a project during this request. The HTTP layer
 * persists it per user; the timesheet sweep reads it back so that what this
 * connector wrote, it can always read.
 */
export function rememberProject(projectId: string, projectName: string): void {
  if (!projectId) return;
  const projects = discoveries().projects;
  if (!projects.has(projectId) || (projectName && !projects.get(projectId))) {
    projects.set(projectId, projectName ?? "");
  }
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export interface Task {
  task_id: string;
  task_name: string;
  project_id: string;
  project_name: string;
  status: string;
  /** Zoho's id for the custom status; needed to change it. */
  status_id: string;
  completed: boolean;
  owner_ids: string[];
  /** Full owner records — the only place a Team Member can see both id spaces. */
  owners: TaskOwner[];
  last_updated?: string;
}

export interface TaskOwner {
  /** Owner-record zpuid. NOT comparable with the login zpuid from /portals/. */
  zpuid: string;
  /** The Zoho user id (600...) that timelogs are stamped with and person_responsible takes. */
  portalUserId: string;
  email: string;
  name: string;
}

interface TaskCache {
  fetchedAt: number;
  tasks: Task[];
}

/**
 * Keyed by user AND portal. "My tasks" differs per person, so a portal-only
 * key would serve one user's task list to another — and log_time matches
 * against whatever is in here.
 */
const taskCaches = new Map<string, TaskCache>();

function taskCacheKey(mineOnly: boolean, projectName = ""): string {
  const { portalId, userId, timelogOwnerId } = effective();
  const scope = mineOnly ? "mine" : `all:${projectName.trim().toLowerCase()}`;
  return `${portalId}:${userId}:${timelogOwnerId}:${scope}`;
}

export function clearTaskCache(): void {
  // The "all" variant is keyed by project name too, so clear every entry
  // belonging to this user rather than guessing the names.
  const prefix = taskCacheKey(true).replace(/:mine$/, "");
  for (const key of [...taskCaches.keys()]) {
    if (key.startsWith(prefix)) taskCaches.delete(key);
  }
}

/** Test hook: forget everything cached in this module. */
export function resetCachesForTests(): void {
  taskCaches.clear();
  projectCaches.clear();
  portalsCache.clear();
  portalMetaCache.clear();
  statusCache.clear();
}

export interface TaskQuery {
  /** Only tasks assigned to the caller (via /mytasks/). Default true. */
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
 * expose hundreds of projects.
 */
export const PROJECT_SWEEP_CAP = Number(process.env.PROJECT_SWEEP_CAP ?? 20);

/**
 * Tasks assigned to the caller, in ONE request (plus paging).
 *
 * This endpoint is what makes the server usable on a large portal. The
 * per-project sweep below issues one request per project, which on a portal
 * exposing hundreds of projects trips Zoho's rolling throttle (100 requests
 * per endpoint per 2 minutes) and locks the account out for half an hour.
 * Returns 204 with an empty body when the user has no tasks.
 */
async function fetchMyTasks(): Promise<Task[]> {
  const out: Task[] = [];
  let index = 1;
  const range = 200;

  for (;;) {
    const json = await request<any>("mytasks/", { query: { index, range } });
    const batch: any[] = json.tasks ?? [];
    for (const t of batch) out.push(toTask(t, ""));
    if (!hasMorePages(batch.length, range)) break;
    index += batch.length;
    if (index > 2000) break;
  }
  return out;
}

/**
 * Every task the account can see, gathered per project. Expensive and capped;
 * only used when explicitly asking for other people's tasks.
 */
async function fetchAllTasks(projectName?: string): Promise<Task[]> {
  const all = await listActiveProjectsCached();

  // Narrow BEFORE capping: sweeping 20 arbitrary projects out of hundreds
  // returns a misleading subset that looks like a complete answer.
  const needle = projectName?.trim().toLowerCase();
  const matching = needle
    ? all.filter((p) => p.project_name.toLowerCase().includes(needle))
    : all;

  if (needle && matching.length === 0) {
    throw new ZohoError(
      `No project matching "${projectName}" is visible to ${effective().label}.`,
      undefined,
      undefined,
      "Run list_projects to see the exact names.",
    );
  }

  if (matching.length > PROJECT_SWEEP_CAP) {
    throw new ZohoError(
      `${matching.length} projects match, which is more than the ${PROJECT_SWEEP_CAP} this ` +
        `server will scan for tasks in one call.`,
      undefined,
      undefined,
      needle
        ? `Narrow project_name further — it must match at most ${PROJECT_SWEEP_CAP} projects ` +
          `(${effective().label} can see ${all.length}).`
        : `${effective().label} can see ${all.length} projects; pass project_name to scope ` +
          `the search, or drop include_others to see your own tasks.`,
    );
  }

  try {
    const batches = await Promise.all(
      matching.map((p) => fetchProjectTasks(p.project_id, p.project_name)),
    );
    return batches.flat();
  } catch (err) {
    if (err instanceof ThrottledError) {
      throw new ZohoError(
        "Zoho throttled the request while scanning projects for tasks.",
        429,
        undefined,
        "Wait two minutes, then use get_my_tasks without include_others, or narrow it " +
          "with project_name.",
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
    task_id: String(t.id_string ?? t.id ?? ""),
    task_name: String(t.name ?? ""),
    project_id: String(t.project?.id_string ?? t.project?.id ?? projectId),
    project_name: String(t.project?.name || projectName),
    status: statusName,
    status_id: String(t.status?.id_string ?? t.status?.id ?? ""),
    completed:
      t.completed === true ||
      String(t.status?.type ?? "").toLowerCase() === "closed" ||
      /^(closed|completed|done)$/i.test(statusName),
    owner_ids: owners
      .flatMap((o) => [o.zpuid, o.id, o.owner_id])
      .map((v) => String(v ?? ""))
      .filter(Boolean),
    owners: owners.map(toOwner),
    last_updated: t.last_updated_time ?? t.created_time,
  };
}

function toOwner(o: any): TaskOwner {
  return {
    zpuid: String(o.zpuid ?? ""),
    portalUserId: String(o.id ?? o.owner_id ?? o.zuid ?? ""),
    email: String(o.email ?? ""),
    name: String(o.full_name ?? o.name ?? ""),
  };
}

/**
 * Is this owner record the caller? Compared on the Zoho user id; on email
 * only when both sides are known. `null` means it cannot be told — callers
 * must not read that as "no".
 */
export function ownerIsCaller(o: TaskOwner): boolean | null {
  const { timelogOwnerId, email } = effective();
  // Compare ids only when BOTH sides have one. Zoho sometimes gives an owner
  // record only a zpuid and a name, and reading that missing id as "not the
  // caller" reports the caller's own task as somebody else's.
  if (timelogOwnerId && o.portalUserId) return o.portalUserId === timelogOwnerId;
  const mine = email.trim().toLowerCase();
  const theirs = o.email.trim().toLowerCase();
  if (mine && theirs) return mine === theirs;
  return null;
}

/** Tri-state: true if the caller is among the owners, false if not, null if unknowable. */
export function taskIsMine(t: Task): boolean | null {
  if (t.owners.length === 0) return effective().timelogOwnerId ? false : null;
  let unknown = false;
  for (const o of t.owners) {
    const r = ownerIsCaller(o);
    if (r === true) return true;
    if (r === null) unknown = true;
  }
  return unknown ? null : false;
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
    if (!hasMorePages(batch.length, range)) break;
    index += batch.length;
    if (index > 2000) break; // safety valve
  }
  return out;
}

export async function getTasks(query: TaskQuery = {}): Promise<Task[]> {
  const { mineOnly = true, openOnly = true, projectName, forceRefresh = false } = query;

  const { label } = effective();
  const cacheKey = taskCacheKey(mineOnly, projectName);
  const cached = taskCaches.get(cacheKey);
  const fresh =
    cached !== undefined &&
    Date.now() - cached.fetchedAt < config.taskCacheTtlSeconds * 1000;

  if (!fresh || forceRefresh) {
    // One request when we only need the caller's own tasks; a capped sweep
    // only when explicitly asked for everyone's.
    const fetched = mineOnly ? await fetchMyTasks() : await fetchAllTasks(projectName);
    taskCaches.set(cacheKey, { fetchedAt: Date.now(), tasks: fetched });
    log.info(`fetched ${fetched.length} ${mineOnly ? "own" : "project"} tasks for ${label}`);
  }

  // No owner filter in either mode. /mytasks/ is already scoped to the caller,
  // and include_others exists precisely to show everyone's. An earlier version
  // filtered the include_others pool down to tasks owned by the caller's LOGIN
  // zpuid, which is not the zpuid on task owner records, so it returned
  // nothing at all.
  let tasks = taskCaches.get(cacheKey)!.tasks;
  if (openOnly) tasks = tasks.filter((t) => !t.completed);
  if (projectName) {
    const needle = projectName.toLowerCase();
    tasks = tasks.filter((t) => t.project_name.toLowerCase().includes(needle));
  }
  return tasks;
}

/**
 * Look up one task by id.
 *
 * With a project id this is a single direct GET. Without one, it searches the
 * caller's own tasks -- also a single request. It must never fall back to
 * scanning the portal: that is thousands of requests to find a task whose id
 * we already know, and it is what made log_time unusable on a large portal.
 */
export async function getTaskById(
  taskId: string,
  projectId?: string,
): Promise<Task | null> {
  const id = String(taskId);

  if (projectId) {
    try {
      const json = await request<any>(`projects/${projectId}/tasks/${id}/`);
      const raw = json.tasks?.[0] ?? json.task;
      if (raw) return toTask(raw, "", projectId);
    } catch (err) {
      // "Zoho says there is no such task" and "the lookup itself failed" are
      // different answers, and reporting the second as the first sends the
      // caller hunting for a task that exists. Only a 404 falls through to the
      // own-tasks search; anything else is raised.
      const notFound = err instanceof ZohoError && err.status === 404;
      if (!notFound) {
        log.warn(`direct task lookup failed for ${id} in project ${projectId}`, String(err));
        throw new ZohoError(
          `Could not look up task ${id} in project ${projectId}: ` +
            (err instanceof Error ? err.message : String(err)),
          err instanceof ZohoError ? err.status : undefined,
          err instanceof ZohoError ? err.code : undefined,
          "The lookup failed; this does not mean the task is missing. Retry before " +
            "concluding it does not exist.",
        );
      }
      log.debug(`task ${id} is not in project ${projectId}`);
    }
  }

  const mine = await getTasks({ mineOnly: true, openOnly: false });
  return mine.find((t) => t.task_id === id) ?? null;
}

export interface CreateTaskInput {
  projectId: string;
  name: string;
  /** Zoho user ids (600...). Defaults to the caller, i.e. assign to self. */
  ownerIds?: string[];
  startIso?: string;
  endIso?: string;
  description?: string;
  priority?: string;
}

export interface CreatedTask {
  task: Task;
  /** The id the task was meant to be assigned to (the caller unless owner_ids was given). */
  callerUserId: string;
  /** Whether Zoho reports the caller among the owners. null = owners not reported. */
  assignedToCaller: boolean | null;
}

/** Zoho's wording when an owner id is not a member of the project. */
const NOT_A_MEMBER = /does not belong to this project|not a member|not a user of this project/i;

/**
 * Create a task, assigned to the caller unless told otherwise.
 *
 * The assignment is explicit. Leaving person_responsible out does NOT make
 * Zoho assign the task to whoever created it: a task this connector created
 * that way ended up owned by a colleague, invisible to /mytasks/, and every
 * read that starts from "my tasks" went blind. Zoho's user id (600...) is what
 * person_responsible takes; the login zpuid is rejected as "does not belong
 * to this project".
 */
export async function createTask(input: CreateTaskInput): Promise<CreatedTask> {
  const callerUserId = await ensureCallerUserId();
  const explicit = (input.ownerIds ?? []).map((v) => String(v).trim()).filter(Boolean);

  if (explicit.length === 0 && !callerUserId) {
    throw new ZohoError(
      `Cannot tell which Zoho user to assign the task to, so nothing was created.`,
      undefined,
      undefined,
      `Zoho did not report a user id for ${effective().label} (empty login_id on /portals/). ` +
        `Reconnect the Zoho account, or pass owner_ids explicitly.`,
    );
  }

  const owners = explicit.length ? explicit : [callerUserId];

  let json: any;
  try {
    json = await request<any>(`projects/${input.projectId}/tasks/`, {
      method: "POST",
      form: {
        name: input.name,
        person_responsible: owners.join(","),
        start_date: input.startIso ? toPortalDate(input.startIso, API_DATE_FORMAT) : undefined,
        end_date: input.endIso ? toPortalDate(input.endIso, API_DATE_FORMAT) : undefined,
        description: input.description,
        priority: input.priority,
      },
    });
  } catch (err) {
    if (err instanceof ZohoError && NOT_A_MEMBER.test(err.message)) {
      const looksLikeZpuid = owners.some((id) => id.length >= 15);
      const hint = explicit.length
        ? `Owner id(s) ${owners.join(", ")} are not members of project ${input.projectId}.` +
          (looksLikeZpuid
            ? " Those look like zpuids; owner_ids takes the Zoho user id — the 600... " +
              "number whoami reports as timelog_owner_id."
            : "") +
          " Nothing was created."
        : `${effective().label} (user id ${callerUserId}) is not a member of project ` +
          `${input.projectId}, so Zoho will not assign a task there to you. Ask the project ` +
          `admin to add you, or pick a project you belong to (list_projects). Nothing was created.`;
      throw new ZohoError(`Zoho refused the assignment: ${err.message}`, err.status, err.code, hint);
    }
    throw err;
  }

  const raw = json.tasks?.[0] ?? json.task ?? json;
  // The new task must be visible to the very next log_time call.
  clearTaskCache();

  const task = toTask(raw, "", input.projectId);
  if (!task.task_name) task.task_name = input.name;
  if (!task.status) task.status = "Open";
  rememberProject(task.project_id, task.project_name);

  // Read the owners back rather than assuming. This is a report, not a way to
  // learn who the caller is: a task Zoho assigned to someone else would
  // otherwise teach us the wrong identity.
  // No owners in the response means Zoho did not say, which is not the same as
  // "it did not assign it to you". Reporting the second sends the user off to
  // repair something that is probably fine.
  const assignedToCaller =
    !callerUserId || task.owners.length === 0
      ? null
      : task.owners.some((o) => o.portalUserId === callerUserId);

  return { task, callerUserId, assignedToCaller };
}

export interface TaskStatus {
  id: string;
  name: string;
  /** "open" | "closed" — Zoho's underlying bucket for the custom status. */
  type: string;
  isDefault: boolean;
}

/** Custom statuses are per project, and stable, so cache them per project. */
const statusCache = new Map<string, TaskStatus[]>();

/**
 * The statuses this project's workflow actually defines.
 *
 * Zoho exposes no reliable endpoint for this on every portal, so after trying
 * the documented paths we fall back to reading the statuses off the project's
 * own tasks. Every task carries its status id and name, which is exactly what
 * a status change needs, and any user who can see the tasks can read it.
 */
export async function listTaskStatuses(projectId: string): Promise<TaskStatus[]> {
  const key = `${effective().portalId}:${projectId}`;
  const cached = statusCache.get(key);
  if (cached) return cached;

  // `tasklayouts` is the documented source of a project's status list; the
  // others are older shapes still present on some portals.
  const paths = [
    `projects/${projectId}/tasklayouts`,
    `projects/${projectId}/tasks/customstatus/`,
    `projects/${projectId}/customstatus/`,
  ];

  for (const path of paths) {
    try {
      const statuses = harvestStatuses(await request<any>(path));
      if (statuses.length > 0) {
        statusCache.set(key, statuses);
        log.info(
          `project ${projectId} statuses via ${path}: ${statuses.map((x) => x.name).join(", ")}`,
        );
        return statuses;
      }
    } catch (err) {
      log.debug(`status lookup failed at ${path}`, String(err));
    }
  }

  // Fallback: whatever statuses the project's tasks are actually using.
  try {
    const tasks = await fetchProjectTasks(projectId, "");
    const byId = new Map<string, TaskStatus>();
    for (const t of tasks) {
      if (t.status_id && t.status && !byId.has(t.status_id)) {
        byId.set(t.status_id, {
          id: t.status_id,
          name: t.status,
          type: t.completed ? "closed" : "open",
          isDefault: false,
        });
      }
    }
    const statuses = [...byId.values()];
    if (statuses.length > 0) {
      statusCache.set(key, statuses);
      log.info(
        `project ${projectId} statuses derived from tasks: ` +
          statuses.map((x) => x.name).join(", "),
      );
      return statuses;
    }
  } catch (err) {
    log.warn(`could not derive statuses from tasks in ${projectId}`, String(err));
  }

  log.warn(`could not read custom statuses for project ${projectId}`);
  statusCache.set(key, []);
  return [];
}

/**
 * Pull status records out of an arbitrarily shaped response.
 *
 * The layout payload nests statuses differently across portal versions, so
 * rather than guess a path we walk the whole tree for objects that look like
 * a status: an id, a name, and an open/closed type.
 */
function harvestStatuses(json: unknown): TaskStatus[] {
  const found = new Map<string, TaskStatus>();

  const visit = (node: any): void => {
    if (node === null || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const id = node.id_string ?? node.id;
    const name = node.name ?? node.status_name;
    const type = String(node.type ?? node.status_type ?? "").toLowerCase();

    if (id !== undefined && typeof name === "string" && (type === "open" || type === "closed")) {
      const key = String(id);
      if (!found.has(key)) {
        found.set(key, {
          id: key,
          name,
          type,
          isDefault: node.is_default === true || node.default === true,
        });
      }
    }

    for (const value of Object.values(node)) visit(value);
  };

  visit(json);
  return [...found.values()];
}

/** Match a spoken status name against the project's workflow. */
export async function resolveStatusId(
  projectId: string,
  wanted: string,
): Promise<TaskStatus | null> {
  const statuses = await listTaskStatuses(projectId);
  if (statuses.length === 0) return null;

  const norm = (v: string) => v.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  const target = norm(wanted);

  return (
    statuses.find((st) => norm(st.name) === target) ??
    statuses.find((st) => norm(st.name).startsWith(target)) ??
    null
  );
}

export interface UpdateTaskInput {
  projectId: string;
  taskId: string;
  name?: string;
  /** Zoho status name, e.g. "Open", "In Progress", "Completed". */
  status?: string;
  priority?: string;
  description?: string;
  startIso?: string;
  endIso?: string;
  percentComplete?: number;
  /** Make the caller the task's owner (person_responsible = caller's user id). */
  assignToMe?: boolean;
}

export interface UpdatedTask {
  task: Task;
  /** Set when assignToMe was requested: whether Zoho now lists the caller as owner. */
  assignedToCaller?: boolean | null;
  callerUserId?: string;
}

/**
 * Update an existing task. Only the fields supplied are sent, so a status
 * change cannot accidentally blank out the description.
 */
export async function updateTask(input: UpdateTaskInput): Promise<UpdatedTask> {
  // Zoho identifies custom statuses by id. A name is accepted and ignored,
  // so resolve it first and fail loudly rather than silently doing nothing.
  let statusId: string | undefined;
  let statusName: string | undefined;

  if (input.status) {
    const match = await resolveStatusId(input.projectId, input.status);
    if (match) {
      statusId = match.id;
    } else {
      const known = (await listTaskStatuses(input.projectId)).map((st) => st.name);
      if (known.length > 0) {
        throw new ZohoError(
          `"${input.status}" is not a status in this project's workflow.`,
          undefined,
          undefined,
          `Available statuses: ${known.join(", ")}.`,
        );
      }
      // Statuses could not be read at all. Send the name and let Zoho decide,
      // rather than refusing a change that may well work.
      log.warn(
        `status list unavailable for project ${input.projectId}; ` +
          `sending "${input.status}" by name`,
      );
      statusName = input.status;
    }
  }

  let callerUserId: string | undefined;
  if (input.assignToMe) {
    callerUserId = await ensureCallerUserId();
    if (!callerUserId) {
      throw new ZohoError(
        "Cannot tell which Zoho user you are, so the task was not reassigned.",
        undefined,
        undefined,
        `Zoho did not report a user id for ${effective().label}. Reconnect the Zoho account.`,
      );
    }
  }

  let json: any;
  try {
    json = await request<any>(`projects/${input.projectId}/tasks/${input.taskId}/`, {
      method: "POST",
      form: {
        name: input.name,
        custom_status: statusId,
        custom_status_name: statusName,
        status: statusName,
        priority: input.priority,
        description: input.description,
        start_date: input.startIso ? toPortalDate(input.startIso, API_DATE_FORMAT) : undefined,
        end_date: input.endIso ? toPortalDate(input.endIso, API_DATE_FORMAT) : undefined,
        percent_complete:
          input.percentComplete === undefined ? undefined : String(input.percentComplete),
        person_responsible: callerUserId,
      },
    });
  } catch (err) {
    if (callerUserId && err instanceof ZohoError && NOT_A_MEMBER.test(err.message)) {
      throw new ZohoError(
        `Zoho refused the assignment: ${err.message}`,
        err.status,
        err.code,
        `${effective().label} (user id ${callerUserId}) is not a member of project ` +
          `${input.projectId}. Ask the project admin to add you; nothing was changed.`,
      );
    }
    throw err;
  }

  clearTaskCache();
  const raw = json.tasks?.[0] ?? json.task ?? json;
  const task = toTask(raw, "", input.projectId);
  if (callerUserId) rememberProject(task.project_id || input.projectId, task.project_name);

  return {
    task,
    callerUserId,
    assignedToCaller: callerUserId
      ? task.owners.length
        ? task.owners.some((o) => o.portalUserId === callerUserId)
        : null
      : undefined,
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
  /** task | bug | general — which kind of Zoho log this is. */
  component: string;
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
        // No `owner`: omitting it makes Zoho attribute the log to the token's
        // own user, which is what we want. (It takes the 600... user id, and
        // passing a zpuid fails with "user does not belong to this project".)
      },
    },
  );

  const raw = json.timelogs?.tasklogs?.[0] ?? json.tasklogs?.[0] ?? json;
  const created = normaliseLog(raw, dateFormat, input.isoDate, undefined, "task");
  created.task_id ??= input.taskId;
  created.project_id ??= input.projectId;
  rememberProject(input.projectId, created.project_name ?? "");
  observeOwnerIdFromWrite(created);
  return created;
}

/**
 * Zoho stamps every timelog with the caller's user id. That is a fact about
 * this request's caller, so it is recorded on this request's context — never
 * in module state, where a concurrent request from someone else could pick it
 * up and be persisted as them.
 *
 * It fills in an unknown identity; it never silently overwrites a known one.
 * A write stamped with a DIFFERENT id than we believe the caller has means
 * something is wrong with the identity, and hiding that by "correcting" it
 * would be worse than reporting it.
 */
function observeOwnerIdFromWrite(created: TimeLog): void {
  const observed = created.owner_id;
  if (!created.log_id || !/^\d{6,}$/.test(observed)) return;

  const believed = effective().timelogOwnerId;
  if (!believed) {
    adoptCallerUserId(observed, "timelog_write");
    log.info(`learned user id ${observed} for ${effective().label} from a timelog write`);
    return;
  }
  if (believed !== observed) {
    log.error(
      `timelog ${created.log_id} is stamped with owner ${observed}, but this server believes ` +
        `${effective().label} is ${believed}`,
    );
    discoveries().ownerIdConflict = { believed, observed };
  }
}

export interface UpdateLogInput {
  projectId: string;
  taskId: string;
  logId: string;
  isoDate?: string;
  hoursHHMM?: string;
  notes?: string;
  billStatus?: string;
}

/** Edit an existing timelog in place. Only the fields supplied are sent. */
export async function updateTimeLog(input: UpdateLogInput): Promise<TimeLog> {
  const json = await request<any>(
    `projects/${input.projectId}/tasks/${input.taskId}/logs/${input.logId}/`,
    {
      method: "POST",
      form: {
        date: input.isoDate ? toPortalDate(input.isoDate, API_DATE_FORMAT) : undefined,
        hours: input.hoursHHMM,
        notes: input.notes,
        bill_status: input.billStatus,
      },
    },
  );

  const raw = json.timelogs?.tasklogs?.[0] ?? json.tasklogs?.[0] ?? json;
  return normaliseLog(raw, API_DATE_FORMAT, input.isoDate, undefined, "task");
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

/** Whether a timelog belongs to the current caller. False when the caller is unknown. */
export function isOwnLog(entry: TimeLog): boolean {
  const owner = effective().timelogOwnerId;
  return Boolean(owner) && entry.owner_id === owner;
}

/** Pages of task logs read before giving up on one task (20 x 200 entries). */
const TASK_LOG_PAGE_LIMIT = 20;

/**
 * Every timelog on one task, paginated. Cheap, and scoped to work the caller
 * can see. Used by the duplicate guard and the ownership check, so it must
 * see the whole history: a daily-logged task passes 200 entries within a year.
 */
export async function fetchTaskLogs(task: Task): Promise<TimeLog[]> {
  const out: TimeLog[] = [];
  let index = 1;
  const range = 200;

  for (let page = 0; page < TASK_LOG_PAGE_LIMIT; page++) {
    const json = await request<any>(
      `projects/${task.project_id}/tasks/${task.task_id}/logs/`,
      { query: { index, range } },
    );
    const entries = extractLogEntries(json);
    for (const { entry, bucketDate, component } of entries) {
      const parsed = normaliseLog(entry, API_DATE_FORMAT, undefined, bucketDate, component);
      out.push({
        ...parsed,
        task_id: parsed.task_id ?? task.task_id,
        task_name: parsed.task_name ?? task.task_name,
        project_id: parsed.project_id ?? task.project_id,
        project_name: parsed.project_name ?? task.project_name,
      });
    }
    if (!hasMorePages(entries.length, range)) break;
    index += entries.length;
  }

  return dedupeLogs(out);
}

export type LogComponent = "task" | "bug" | "general";

export interface ProjectMonthQuery {
  projectId: string;
  projectName: string;
  /** First day of the month, MM-01-yyyy. */
  monthDate: string;
  component: LogComponent;
  /** A Zoho user id, or "all". */
  usersList: string;
  /** Callers running a sweep pass true so a throttle stops them instead of stalling. */
  noRetryOnRateLimit?: boolean;
  /**
   * Called before each HTTP request. Returning false stops the read and marks
   * the result incomplete, so a sweep can budget actual Zoho calls instead of
   * assuming one per project-month.
   */
  beforeRequest?: () => boolean;
}

/** Pages read for one project-month before giving up (10 x 200 entries). */
const MONTH_LOG_PAGE_LIMIT = 10;

/**
 * One project's timelogs for one calendar month and one component type.
 *
 * This is the endpoint Zoho's own timesheet view uses. It rejects
 * view_type=custom_date on this portal, hence one call per month. Throws on
 * any error — the caller decides what a failure means for its coverage.
 */
export async function fetchProjectMonthLogs(
  q: ProjectMonthQuery,
): Promise<{ logs: TimeLog[]; complete: boolean; requests: number }> {
  const out: TimeLog[] = [];
  let index = 1;
  let requests = 0;
  const range = 200;
  // The month this call asked for, used to catch a response whose dates come
  // back in the other day/month order.
  const [wantMonth, , wantYear] = q.monthDate.split("-");

  for (let page = 0; page < MONTH_LOG_PAGE_LIMIT; page++) {
    if (q.beforeRequest && !q.beforeRequest()) {
      return { logs: dedupeLogs(out), complete: false, requests };
    }
    let json: any;
    requests++;
    try {
      json = await request<any>(`projects/${q.projectId}/logs/`, {
        query: {
          users_list: q.usersList,
          view_type: "month",
          date: q.monthDate,
          bill_status: "All",
          component_type: q.component,
          index,
          range,
        },
        noRetryOnRateLimit: q.noRetryOnRateLimit,
      });
    } catch (err) {
      if (isThrottle(err)) throw new ThrottledError(String(err));
      throw err;
    }

    const entries = extractLogEntries(json);
    for (const { entry, bucketDate, component } of entries) {
      const parsed = normaliseLog(
        entry,
        API_DATE_FORMAT,
        undefined,
        bucketDate,
        component ?? q.component,
        { month: wantMonth, year: wantYear },
      );
      out.push({
        ...parsed,
        project_id: parsed.project_id ?? q.projectId,
        project_name: parsed.project_name ?? q.projectName,
      });
    }
    if (!hasMorePages(entries.length, range)) break;
    index += entries.length;
    if (page === MONTH_LOG_PAGE_LIMIT - 1) {
      return { logs: dedupeLogs(out), complete: false, requests };
    }
  }

  return { logs: dedupeLogs(out), complete: true, requests };
}

/**
 * Timelog responses come in two shapes: bucketed by day
 * (timelogs.date[].tasklogs/buglogs/generallogs) or a flat list
 * (timelogs.tasklogs). Flatten either into entries with their bucket date.
 */
function extractLogEntries(
  json: any,
): Array<{ entry: any; bucketDate?: string; component?: LogComponent }> {
  const out: Array<{ entry: any; bucketDate?: string; component?: LogComponent }> = [];
  const buckets: any[] = json?.timelogs?.date ?? [];
  for (const bucket of buckets) {
    for (const entry of bucket.tasklogs ?? []) {
      out.push({ entry, bucketDate: bucket.date, component: "task" });
    }
    for (const entry of bucket.buglogs ?? []) {
      out.push({ entry, bucketDate: bucket.date, component: "bug" });
    }
    for (const entry of bucket.generallogs ?? []) {
      out.push({ entry, bucketDate: bucket.date, component: "general" });
    }
  }
  for (const entry of json?.timelogs?.tasklogs ?? []) out.push({ entry, component: "task" });
  for (const entry of json?.timelogs?.buglogs ?? []) out.push({ entry, component: "bug" });
  for (const entry of json?.timelogs?.generallogs ?? []) {
    out.push({ entry, component: "general" });
  }
  return out;
}

/** Drop repeated log ids (a paginated read can overlap when Zoho re-sorts). */
export function dedupeLogs(logs: TimeLog[]): TimeLog[] {
  const seen = new Set<string>();
  const out: TimeLog[] = [];
  for (const l of logs) {
    // Only a real log id proves two rows are the same entry. Two genuine
    // entries can share task, date, duration, owner and note — two sittings on
    // one task, or two general logs on one day — so an id-less row is kept
    // rather than collapsed into its twin, which would under-report the hours.
    if (!l.log_id) {
      out.push(l);
      continue;
    }
    if (seen.has(l.log_id)) continue;
    seen.add(l.log_id);
    out.push(l);
  }
  return out;
}

let warnedSwappedDate = false;

/** Test hook: let the once-per-process date warning fire again. */
export function resetDateWarningForTests(): void {
  warnedSwappedDate = false;
}

function normaliseLog(
  raw: any,
  dateFormat: string,
  knownIso?: string,
  bucketDate?: string,
  component: LogComponent | string = "task",
  /** The month this response was requested for, when the caller knows it. */
  expected?: { month: string; year: string },
): TimeLog {
  const rawDate = raw?.log_date ?? raw?.date ?? bucketDate ?? "";
  let iso = knownIso ?? fromPortalDate(String(rawDate), dateFormat) ?? String(rawDate);

  // Dates are read as MM-dd-yyyy, which is what the API documents and what
  // this portal returns. Two things can still go wrong, and either would drop
  // the hours silently out of the requested range rather than fail loudly:
  //
  //  - a day/month swap landing on an impossible month ("2026-26-08");
  //  - a swap landing on a plausible one (5 Sep read as 9 May), which is only
  //    detectable against the month the response was actually asked for.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m) {
    const [, yy, mo, dd] = m;
    const impossible = Number(mo) > 12 && Number(dd) >= 1 && Number(dd) <= 12;
    const wrongMonth = expected !== undefined && (mo !== expected.month || yy !== expected.year);
    const swapWouldFit = expected !== undefined && dd === expected.month && yy === expected.year;

    if (impossible || (wrongMonth && swapWouldFit)) {
      iso = `${yy}-${dd}-${mo}`;
      if (!warnedSwappedDate) {
        warnedSwappedDate = true;
        log.warn(
          `timelog date "${rawDate}" did not fit ${dateFormat}; read it as ${iso}. ` +
            `This portal returns dates in the other day/month order.`,
        );
      }
    }
  }

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
    component: String(component),
  };
}
