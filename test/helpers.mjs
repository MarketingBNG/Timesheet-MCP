/**
 * Test harness. The Zoho credentials in .env are dead and the portal cannot be
 * reached from CI anyway, so every test drives the compiled server against a
 * scripted `fetch`. Handlers are matched on method + URL pathname, and every
 * call is recorded so a test can assert on request COUNT — which is how the
 * throttle-avoidance budget is pinned down.
 */
import { mock } from "node:test";

/** config.ts exits the process on a missing variable, so set them before import. */
export function setEnv(extra = {}) {
  Object.assign(process.env, {
    ZOHO_CLIENT_ID: "1000.test",
    ZOHO_CLIENT_SECRET: "secret",
    ZOHO_REFRESH_TOKEN: "1000.refresh",
    ZOHO_PORTAL_ID: "60037687374",
    ZOHO_USER_ID: "283967000004030700",
    ZOHO_DOMAIN: "in",
    // Explicitly empty: dotenv will not override a key that is already set, so
    // this keeps a developer's real .env out of the tests AND makes the server
    // resolve the caller from /portals/ login_id, which is what we are testing.
    ZOHO_TIMELOG_OWNER_ID: "",
    ZOHO_PEOPLE_EMPLOYEE_ID: "",
    ZOHO_MAX_CONCURRENCY: "3",
    TASK_CACHE_TTL_SECONDS: "300",
    AUDIT_LOG_PATH: "",
    ...extra,
  });
  // An empty AUDIT_LOG_PATH would resolve to the package dir; point it at a
  // temp file so tests never append to the real audit trail.
  if (!process.env.AUDIT_LOG_PATH) {
    process.env.AUDIT_LOG_PATH = new URL("./tmp-audit.jsonl", import.meta.url).pathname.replace(
      /^\/([A-Za-z]:)/,
      "$1",
    );
  }
}

export const PORTAL = "60037687374";
export const API = `https://projects.zoho.in/restapi`;

/**
 * @param {Array<{match: (url: URL, init: any) => boolean, respond: (url: URL, init: any, call: number) => any}>} routes
 */
export function installFetch(routes) {
  const calls = [];

  const handler = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const record = {
      method,
      url,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : undefined,
    };
    calls.push(record);

    // Token refresh is not what any of these tests are about.
    if (url.pathname.includes("/oauth/v2/token")) {
      return json({ access_token: "at", expires_in: 3600 });
    }

    for (const route of routes) {
      if (route.match(url, { ...init, method })) {
        const seen = calls.filter((c) => route.match(c.url, { method: c.method })).length;
        const out = await route.respond(url, { ...init, method }, seen);
        return out instanceof Response ? out : json(out);
      }
    }
    return json({ error: { code: 404, message: `unrouted ${method} ${url.pathname}` } }, 404);
  };

  mock.method(globalThis, "fetch", handler);
  return {
    calls,
    /** Calls whose path contains `needle`. */
    to(needle) {
      return calls.filter((c) => c.path.includes(needle));
    },
    reset() {
      calls.length = 0;
    },
  };
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** GET /restapi/portals/ — carries login_id, the caller's Zoho user id. */
export function portalsRoute(loginId = "60067377390", extra = {}) {
  return {
    match: (url) => url.pathname.endsWith("/restapi/portals/"),
    respond: () => ({
      login_id: loginId,
      portals: [
        {
          id: Number(PORTAL),
          id_string: PORTAL,
          name: "bngadvisorsprivateltd",
          login_zpuid: "283967000004030700",
          settings: { date_format: "dd/MM/yyyy hh:mm aaa" },
          ...extra,
        },
      ],
    }),
  };
}

/** A Zoho v1 task row as the API returns it. */
export function task({
  id,
  name,
  projectId = "283967000001053334",
  projectName = "Marketing_SGS_Zoho",
  owners = [{ zpuid: "283967000004030675", id: "60067377390", email: "shweta@usaindiacfo.com", name: "Shweta Ramani" }],
  completed = false,
  status = "Open",
}) {
  return {
    id_string: id,
    id,
    name,
    status: { id_string: "s1", name: status, type: completed ? "closed" : "open" },
    completed,
    project: { id_string: projectId, name: projectName },
    details: { owners },
    last_updated_time: "09-01-2026",
  };
}

/** A Zoho v1 timelog row. */
export function timelog({
  id,
  date,
  hours = "01:00",
  ownerId = "60067377390",
  ownerName = "Shweta Ramani",
  taskId = "t1",
  taskName = "Work Review",
  projectId = "283967000001053334",
  projectName = "Marketing_SGS_Zoho",
  notes = "",
}) {
  return {
    id_string: id,
    id,
    log_date: date, // MM-dd-yyyy
    hours_display: hours,
    hours: Number(hours.split(":")[0]),
    owner_id: ownerId,
    owner_name: ownerName,
    notes,
    bill_status: "Billable",
    task: { id_string: taskId, name: taskName },
    project: { id_string: projectId, name: projectName },
  };
}

/** Wrap timelogs in the bucketed shape Zoho uses. */
export function bucketed(logs, key = "tasklogs") {
  const byDate = new Map();
  for (const l of logs) {
    if (!byDate.has(l.log_date)) byDate.set(l.log_date, []);
    byDate.get(l.log_date).push(l);
  }
  return {
    timelogs: {
      date: [...byDate].map(([date, entries]) => ({ date, [key]: entries })),
    },
  };
}

/**
 * The built modules, with every module-level cache cleared.
 *
 * They must be the SAME instances the server uses, so they are imported
 * unsuffixed and reset instead of re-imported: a `?t=n` copy would give the
 * test a different cache than the server under test.
 */
export async function loadModules() {
  const [zoho, timesheet, context, server, format, people] = await Promise.all([
    import("../dist/zoho.js"),
    import("../dist/timesheet.js"),
    import("../dist/context.js"),
    import("../dist/server.js"),
    import("../dist/format.js"),
    import("../dist/people.js"),
  ]);
  zoho.resetCachesForTests();
  timesheet.resetForTests();
  context.resetForTests();
  return { zoho, timesheet, context, server, format, people };
}

/** Call an MCP tool on a built server and return its text + parsed JSON block. */
export async function callTool(mcpServer, name, args = {}) {
  const registered = mcpServer._registeredTools?.[name];
  if (!registered) throw new Error(`no such tool: ${name}`);

  // Go through the declared schema so zod defaults apply, exactly as they do
  // for a real client call.
  let parsed = args;
  const shape = registered.inputSchema;
  if (shape && typeof shape.parse === "function") parsed = shape.parse(args);

  const result = await registered.handler(parsed, { signal: new AbortController().signal });
  const text = result.content.map((c) => c.text).join("\n");
  let data;
  const brace = text.indexOf("\n\n{");
  const bracket = text.indexOf("\n\n[");
  const at = brace === -1 ? bracket : bracket === -1 ? brace : Math.min(brace, bracket);
  if (at !== -1) {
    try {
      data = JSON.parse(text.slice(at + 2));
    } catch {
      /* not every result carries a JSON block */
    }
  }
  return { text, data, isError: Boolean(result.isError) };
}
