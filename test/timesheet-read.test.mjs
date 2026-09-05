/**
 * The read side: get_timesheet_status must never report a confident zero for
 * hours it did not actually look for. These tests encode the reported bug and
 * each of its causes.
 */
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  API,
  PORTAL,
  bucketed,
  callTool,
  installFetch,
  json,
  loadModules,
  portalsRoute,
  setEnv,
  task,
  timelog,
} from "./helpers.mjs";

setEnv();

const MKT = "283967000001053334";
const ZUID = "60067377390";

afterEach(() => mock.restoreAll());

/** Routes for a user with 42 own tasks in one project, 8h/day logged in August. */
function shwetaRoutes({ projects = 349, monthLogs = true } = {}) {
  const own = Array.from({ length: 42 }, (_, i) =>
    task({ id: `t${i}`, name: `Task ${i}`, projectId: MKT }),
  );
  const augLogs = Array.from({ length: 5 }, (_, i) =>
    timelog({ id: `l${i}`, date: `08-0${i + 1}-2026`, hours: "08:00", taskId: "t0" }),
  );

  return [
    portalsRoute(ZUID),
    {
      match: (u) => u.pathname.endsWith("/mytasks/"),
      respond: (u) => (Number(u.searchParams.get("index")) > 1 ? { tasks: [] } : { tasks: own }),
    },
    {
      match: (u) => u.pathname.endsWith(`/portal/${PORTAL}/projects/`),
      respond: (u) =>
        Number(u.searchParams.get("index")) > 1
          ? { projects: [] }
          : {
              projects: Array.from({ length: projects }, (_, i) => ({
                id_string: i === 0 ? MKT : `p${i}`,
                name: i === 0 ? "Marketing_SGS_Zoho" : `Project ${i}`,
                status: "active",
              })),
            },
    },
    {
      // Project-level month view.
      match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
      respond: (u) => {
        if (!monthLogs) return bucketed([]);
        const isMkt = u.pathname.includes(MKT);
        const isAugust = u.searchParams.get("date") === "08-01-2026";
        const isTask = u.searchParams.get("component_type") === "task";
        return isMkt && isAugust && isTask ? bucketed(augLogs) : bucketed([]);
      },
    },
    {
      // Per-task logs (duplicate guard and cross-check).
      match: (u) => /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
      respond: () => bucketed([]),
    },
  ];
}

test("reports hours it found, and names the projects it read", async () => {
  const fetchMock = installFetch(shwetaRoutes());
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, text, isError } = await callTool(mcp, "get_timesheet_status", {
    date_from: "2026-08-01",
    date_to: "2026-08-05",
    include_entries: true,
  });

  assert.equal(isError, false);
  assert.equal(data.total_hours_found, 40);
  assert.equal(data.entries.length, 5);
  assert.ok(text.includes("Marketing_SGS_Zoho"), "summary names the scanned project");
  assert.deepEqual(data.coverage.basis, ["own_tasks"]);
  assert.equal(data.coverage.projects_visible, 349);
  // Only a fraction of a 349-project portal was read, so the hours found are a
  // floor and the tool must say so rather than present them as a total.
  assert.equal(data.is_complete, false);
  assert.equal(data.coverage.covers_whole_timesheet, false);
  assert.ok(/LOWER BOUND/.test(text));
  assert.ok(data.coverage.incomplete_because.length > 0);
  assert.ok(fetchMock.to("/logs/").length <= 25, "did not sweep the whole portal");
});

test("a user with no tasks and no writes gets an undetermined result, never 0h", async () => {
  // This is the reported bug: 349 projects, none of them the user's, and the
  // old code scanned the first 20 and said "0.00h logged".
  const routes = shwetaRoutes();
  routes[1] = { match: (u) => u.pathname.endsWith("/mytasks/"), respond: () => ({ tasks: [] }) };
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, text, isError } = await callTool(mcp, "get_timesheet_status", {
    date_from: "2026-09-01",
    date_to: "2026-09-04",
  });

  assert.equal(isError, true, "an unreadable timesheet is an error, not a zero");
  assert.equal(data.status, "undetermined");
  assert.equal(data.reason_code, "no_projects_to_scan");
  assert.ok(!/0\.00h logged/.test(text));
  assert.ok(text.includes("349"), "says how many projects it could not read blind");
  assert.ok(data.resolution.some((r) => /project_name/.test(r)));
});

test("a small portal is read in full, so hours on a colleague's task are found", async () => {
  const routes = shwetaRoutes({ projects: 3 });
  routes[1] = { match: (u) => u.pathname.endsWith("/mytasks/"), respond: () => ({ tasks: [] }) };
  routes[3] = {
    match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
    respond: (u) =>
      u.pathname.includes("p2") && u.searchParams.get("component_type") === "task"
        ? bucketed([timelog({ id: "x1", date: "09-01-2026", hours: "07:00" })])
        : bucketed([]),
  };
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, isError } = await callTool(mcp, "get_timesheet_status", {
    date_from: "2026-09-01",
    date_to: "2026-09-02",
  });

  assert.equal(isError, false);
  assert.equal(data.total_hours_found, 7);
  assert.ok(data.coverage.basis.includes("all_projects"));
  // Every visible project, every month, every component, nothing failed: only
  // here may a day with no hours be called empty.
  assert.equal(data.coverage.covers_whole_timesheet, true);
  assert.equal(data.is_complete, true);
  assert.deepEqual(data.days_missing, ["2026-09-02"]);
  assert.deepEqual(data.days_unknown, []);
});

test("a failed project-month makes those days unknown, not empty", async () => {
  const routes = shwetaRoutes();
  routes[3] = {
    match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
    respond: () => json({ error: { code: 6831, message: "nope" } }, 400),
  };
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, text } = await callTool(mcp, "get_timesheet_status", {
    date_from: "2026-09-01",
    date_to: "2026-09-02",
  });

  assert.deepEqual(data.days_missing, [], "nothing may be called confirmed-empty");
  assert.deepEqual(data.days_unknown, ["2026-09-01", "2026-09-02"]);
  assert.ok(data.coverage.scan_errors.length > 0);
  assert.ok(/could not be confirmed/i.test(text));
  assert.ok(/do NOT treat those days as empty/.test(text));
});

test("a throttle aborts the sweep instead of burning the remaining quota", async () => {
  const routes = shwetaRoutes({ projects: 3 });
  routes[1] = { match: (u) => u.pathname.endsWith("/mytasks/"), respond: () => ({ tasks: [] }) };
  routes[3] = {
    match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
    respond: () => json({ error: { code: "THROTTLE", message: "more than 100 requests" } }, 429),
  };
  const fetchMock = installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, text } = await callTool(mcp, "get_timesheet_status", {
    date_from: "2026-07-01",
    date_to: "2026-09-30",
  });

  assert.equal(data.coverage.throttled, true);
  assert.ok(/NOT complete/.test(text));
  assert.ok(data.coverage.incomplete_because.some((r) => /throttl/i.test(r)));
  // 3 projects x 3 months x 2 components = 18 planned; the abort must stop it
  // long before that, and there must be no 429 retry storm either.
  assert.ok(
    fetchMock.to("/logs/").length < 10,
    `expected an early abort, made ${fetchMock.to("/logs/").length} calls`,
  );
  assert.deepEqual(data.days_missing, []);
});

test("the request budget caps a wide sweep and says the read was cut short", async () => {
  // Own tasks spread over 10 projects; 10 x 6 months x 2 components = 120
  // planned calls against a budget of 60. Without the budget this is what
  // trips Zoho's 100-per-2-minutes limit and locks the account out.
  const spread = Array.from({ length: 10 }, (_, i) =>
    task({ id: `t${i}`, name: `Task ${i}`, projectId: `p${i}`, projectName: `Project ${i}` }),
  );
  const routes = shwetaRoutes({ projects: 349 });
  routes[1] = { match: (u) => u.pathname.endsWith("/mytasks/"), respond: (u) =>
    Number(u.searchParams.get("index")) > 1 ? { tasks: [] } : { tasks: spread } };
  installFetch(routes);
  const { timesheet } = await loadModules();

  const result = await timesheet.sweepTimeLogs({ fromIso: "2026-04-01", toIso: "2026-09-30" });

  assert.equal(result.coverage.truncated, true);
  assert.ok(
    result.coverage.requests <= timesheet.SWEEP_REQUEST_BUDGET + 15,
    `spent ${result.coverage.requests} requests`,
  );
  // The sweep is ordered latest-month-first and completes each month across
  // every project, so what a truncation costs is whole OLD months — which are
  // reported as unknown — rather than a silent hole in a recent one.
  assert.ok(result.coverage.months_unknown.length > 0, "unread months are declared unknown");
  assert.ok(
    !result.coverage.months_unknown.includes("2026-09"),
    "the most recent month is read first and must be complete",
  );
  assert.ok(result.coverage.months_unknown.includes("2026-04"), "the oldest month is dropped first");
});

test("falls back to reading everyone's logs when Zoho rejects a user id filter", async () => {
  const routes = shwetaRoutes();
  routes[3] = {
    match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
    respond: (u) => {
      if (u.searchParams.get("users_list") !== "all") {
        return json({ error: { code: 6831, message: "invalid users_list" } }, 400);
      }
      return u.pathname.includes(MKT) && u.searchParams.get("component_type") === "task"
        ? bucketed([
            timelog({ id: "mine", date: "09-01-2026", hours: "03:00" }),
            timelog({ id: "theirs", date: "09-01-2026", hours: "09:00", ownerId: "60067235894", ownerName: "Lakshya" }),
          ])
        : bucketed([]);
    },
  };
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data } = await callTool(mcp, "get_timesheet_status", {
    date_from: "2026-09-01",
    date_to: "2026-09-01",
    include_entries: true,
  });

  assert.equal(data.total_hours_found, 3, "a colleague's 9h must not be counted as mine");
  assert.equal(data.entries.length, 1);
  assert.ok(data.coverage.users_list_fallbacks > 0);
  // The fallback costs a second HTTP call per project-month; the budget must
  // count those, not just the planned reads.
  assert.ok(data.coverage.zoho_requests > data.coverage.projects_scanned.length);
});

test("general time logs count too, and bug logs are declared as not counted", async () => {
  const routes = shwetaRoutes();
  routes[3] = {
    match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
    respond: (u) => {
      const c = u.searchParams.get("component_type");
      if (!u.pathname.includes(MKT) || u.searchParams.get("date") !== "09-01-2026") {
        return bucketed([]);
      }
      if (c === "general") {
        return bucketed(
          [timelog({ id: "g1", date: "09-01-2026", hours: "02:00" })],
          "generallogs",
        );
      }
      return c === "task" ? bucketed([timelog({ id: "t1", date: "09-01-2026", hours: "01:00" })]) : bucketed([]);
    },
  };
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data } = await callTool(mcp, "get_timesheet_status", {
    date_from: "2026-09-01",
    date_to: "2026-09-01",
  });

  assert.equal(data.total_hours_found, 3, "task 1h + general 2h");
  assert.deepEqual(data.coverage.components_counted, ["task", "general", "bug"]);
});

test("the per-task cross-check rescues entries the project month view misses", async () => {
  const routes = shwetaRoutes({ monthLogs: false });
  routes[4] = {
    match: (u) => /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
    respond: (u) =>
      u.pathname.includes("/tasks/t0/")
        ? bucketed([timelog({ id: "hidden", date: "09-01-2026", hours: "04:00", taskId: "t0" })])
        : bucketed([]),
  };
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, text } = await callTool(mcp, "get_timesheet_status", {
    date_from: "2026-09-01",
    date_to: "2026-09-01",
  });

  assert.equal(data.total_hours_found, 4);
  assert.equal(data.coverage.own_task_check.extra_logs_found, 1);
  assert.ok(/cross-check/.test(text));
});

test("project_name scopes the read to a project the user owns no tasks in", async () => {
  const routes = shwetaRoutes();
  routes[1] = { match: (u) => u.pathname.endsWith("/mytasks/"), respond: () => ({ tasks: [] }) };
  routes[3] = {
    match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
    respond: (u) =>
      u.pathname.includes(MKT) && u.searchParams.get("component_type") === "task"
        ? bucketed([timelog({ id: "s1", date: "09-02-2026", hours: "06:00" })])
        : bucketed([]),
  };
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, isError } = await callTool(mcp, "get_timesheet_status", {
    date_from: "2026-09-01",
    date_to: "2026-09-02",
    project_name: "Marketing",
  });

  assert.equal(isError, false);
  assert.equal(data.total_hours_found, 6);
  assert.deepEqual(data.coverage.basis, ["explicit"]);
  // A scoped read says nothing about the rest of the timesheet, so the empty
  // day must not be reported as confirmed-empty.
  assert.equal(data.coverage.covers_whole_timesheet, false);
  assert.deepEqual(data.days_missing, []);
  assert.deepEqual(data.days_unknown, ["2026-09-01"]);
});

test("without an identity nothing is reported rather than everyone's hours", async () => {
  const routes = shwetaRoutes();
  routes[0] = portalsRoute(""); // Zoho reports no login_id
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, isError, text } = await callTool(mcp, "get_timesheet_status", {
    date_from: "2026-08-01",
    date_to: "2026-08-05",
  });

  assert.equal(isError, true);
  assert.equal(data.reason_code, "identity_unknown");
  assert.ok(!/0\.00h/.test(text));
});
