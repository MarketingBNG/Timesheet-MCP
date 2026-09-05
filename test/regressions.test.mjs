/**
 * Defects found by review of the fix itself. Each one produced a wrong answer
 * silently, which is the failure mode this whole change exists to remove.
 */
import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
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
const ME = "60067377390";

afterEach(() => mock.restoreAll());

test("a page Zoho caps below the range asked for does not skip the next page", async () => {
  // The loop asked for 200, Zoho returned 100, and the cursor jumped to 201 —
  // so rows 101-200 were never read and the loop still ended normally. On a
  // 349-project portal that quietly hid a third of the projects from the sweep.
  const projects = Array.from({ length: 250 }, (_, i) => ({
    id_string: `p${i}`,
    name: `Project ${i}`,
    status: "active",
  }));
  const seenIndexes = [];
  installFetch([
    portalsRoute(ME),
    {
      match: (u) => u.pathname.endsWith(`/portal/${PORTAL}/projects/`),
      respond: (u) => {
        const index = Number(u.searchParams.get("index"));
        seenIndexes.push(index);
        // Zoho's server-side cap: 100 rows, whatever we asked for.
        return { projects: projects.slice(index - 1, index - 1 + 100) };
      },
    },
  ]);
  const { zoho } = await loadModules();

  const got = await zoho.listProjects(true);

  assert.equal(got.length, 250, "every project must be read");
  assert.deepEqual(seenIndexes, [1, 101, 201], "the cursor follows the rows actually received");
  assert.equal(got[249].project_id, "p249");
});

test("a task lookup that errors is not reported as a missing task", async () => {
  installFetch([
    portalsRoute(ME),
    { match: (u) => u.pathname.endsWith("/mytasks/"), respond: () => ({ tasks: [] }) },
    {
      match: (u) => /\/projects\/[^/]+\/tasks\/[^/]+\/$/.test(u.pathname),
      respond: () => json({ error: { code: 500, message: "Internal error" } }, 500),
    },
    {
      match: (u) => u.pathname.endsWith(`/portal/${PORTAL}/projects/`),
      respond: () => ({ projects: [] }),
    },
  ]);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { text, isError } = await callTool(mcp, "log_time", {
    task_id: "t1",
    project_id: MKT,
    hours: 1,
    date: "2026-09-01",
  });

  assert.equal(isError, true);
  assert.ok(/Could not look up task/.test(text));
  assert.ok(!/Could not find task/.test(text), "must not claim the task does not exist");
  assert.ok(/does not mean the task is missing/.test(text));
});

test("two identical id-less log entries are both counted", async () => {
  // General logs can come back without an id. Keying dedupe on the fields
  // instead collapsed two real one-hour sittings into one.
  installFetch([
    portalsRoute(ME),
    {
      match: (u, i) => i.method === "GET" && /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
      respond: () =>
        bucketed([
          { ...timelog({ id: "", date: "09-01-2026", hours: "01:00", ownerId: ME }), id_string: undefined, id: undefined },
          { ...timelog({ id: "", date: "09-01-2026", hours: "01:00", ownerId: ME }), id_string: undefined, id: undefined },
        ]),
    },
  ]);
  const { zoho } = await loadModules();

  const logs = await zoho.fetchTaskLogs({
    task_id: "t1",
    project_id: MKT,
    task_name: "T",
    project_name: "P",
  });

  assert.equal(logs.length, 2, "two real entries, not one");
  assert.equal(logs.reduce((a, l) => a + l.hours, 0), 2);
});

test("a task owner with no user id is unknown ownership, not somebody else's", async () => {
  installFetch([
    portalsRoute(ME),
    {
      match: (u) => u.pathname.endsWith("/mytasks/"),
      respond: () => ({
        tasks: [
          task({
            id: "a",
            name: "Only a zpuid on the owner",
            owners: [{ zpuid: "283967000004030675", name: "Shweta Ramani" }],
          }),
        ],
      }),
    },
  ]);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data } = await callTool(mcp, "get_my_tasks", { include_completed: true });

  assert.equal(data[0].mine, null, "no id to compare means unknown, not false");
});

test("create_task does not cry wolf when Zoho reports no owners at all", async () => {
  installFetch([
    portalsRoute(ME),
    { match: (u) => u.pathname.endsWith("/mytasks/"), respond: () => ({ tasks: [] }) },
    {
      match: (u, i) => i.method === "POST" && /\/projects\/[^/]+\/tasks\/$/.test(u.pathname),
      // No details.owners in the response — Zoho did not say either way.
      respond: () => ({ tasks: [{ id_string: "new1", name: "Thing", project: { id_string: MKT } }] }),
    },
  ]);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { text, data } = await callTool(mcp, "create_task", { project_id: MKT, name: "Thing" });

  assert.equal(data.assigned_to_caller, null);
  assert.ok(!/did NOT assign it to you/.test(text));
  assert.ok(/did not report owners/.test(text));
});

test("a /portals/ response with no login_id is not cached as the answer", async () => {
  let calls = 0;
  installFetch([
    {
      match: (u) => u.pathname.endsWith("/restapi/portals/"),
      respond: () => {
        calls++;
        // Answers properly only on the second attempt.
        return calls === 1
          ? { portals: [{ id_string: PORTAL, name: "p", login_zpuid: "z" }] }
          : { login_id: ME, portals: [{ id_string: PORTAL, name: "p", login_zpuid: "z" }] };
      },
    },
  ]);
  const { zoho } = await loadModules();

  assert.equal(await zoho.getLoginUserId(), "", "first attempt cannot answer");
  assert.equal(await zoho.getLoginUserId(), ME, "a retry must actually reach Zoho again");
  assert.equal(calls, 2);
});

test("a project whose reads all failed is reported as unscanned, not as nothing", async () => {
  installFetch([
    portalsRoute(ME),
    {
      match: (u) => u.pathname.endsWith("/mytasks/"),
      respond: () => ({ tasks: [task({ id: "t1", name: "T", projectId: MKT })] }),
    },
    {
      match: (u) => u.pathname.endsWith(`/portal/${PORTAL}/projects/`),
      respond: () => ({ projects: [{ id_string: MKT, name: "Marketing_SGS_Zoho", status: "active" }] }),
    },
    {
      match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
      respond: () => json({ error: { code: 6831, message: "nope" } }, 400),
    },
    {
      match: (u, i) => i.method === "GET" && /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
      respond: () => bucketed([]),
    },
  ]);
  const { timesheet } = await loadModules();

  const { coverage } = await timesheet.sweepTimeLogs({
    fromIso: "2026-09-01",
    toIso: "2026-09-01",
  });

  assert.deepEqual(coverage.projects_scanned, []);
  assert.equal(coverage.projects_unscanned.length, 1, "the project must appear somewhere");
  assert.equal(coverage.projects_unscanned[0].project_id, MKT);
  assert.equal(coverage.covers_whole_timesheet, false);
});

test("the sweep budget counts real HTTP calls, including the users_list fallback", async () => {
  // Every project-month needs two calls here: the user-scoped read is rejected
  // and retried for everyone. Budgeting planned items rather than requests let
  // a sweep issue twice what it thought and trip Zoho's rate limit.
  const projects = Array.from({ length: 40 }, (_, i) => ({
    id_string: `p${i}`,
    name: `Project ${i}`,
    status: "active",
  }));
  const fetchMock = installFetch([
    portalsRoute(ME),
    {
      match: (u) => u.pathname.endsWith("/mytasks/"),
      respond: () => ({
        tasks: projects.map((p, i) =>
          task({ id: `t${i}`, name: `T${i}`, projectId: p.id_string, projectName: p.name }),
        ),
      }),
    },
    {
      match: (u) => u.pathname.endsWith(`/portal/${PORTAL}/projects/`),
      respond: () => ({ projects }),
    },
    {
      match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
      respond: (u) =>
        u.searchParams.get("users_list") === "all"
          ? bucketed([])
          : json({ error: { code: 6831, message: "invalid users_list" } }, 400),
    },
    {
      match: (u, i) => i.method === "GET" && /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
      respond: () => bucketed([]),
    },
  ]);
  const { timesheet } = await loadModules();

  const { coverage } = await timesheet.sweepTimeLogs({
    fromIso: "2026-09-01",
    toIso: "2026-09-30",
  });

  const logCalls = fetchMock.to("/logs/").length;
  assert.ok(coverage.users_list_fallbacks > 0, "the fallback was exercised");
  assert.ok(
    logCalls <= timesheet.SWEEP_REQUEST_BUDGET + 5,
    `made ${logCalls} calls against a budget of ${timesheet.SWEEP_REQUEST_BUDGET}`,
  );
  assert.ok(logCalls < 100, "must stay under Zoho's per-endpoint limit");
  assert.equal(coverage.truncated, true);
});

test("a timesheet returned in the other day/month order is read correctly", async () => {
  // 05-09-2026 as dd-MM-yyyy is 5 September. Read as MM-dd-yyyy it becomes
  // 9 May — a plausible date, so nothing looks wrong; the hours simply fall
  // outside the requested range and vanish.
  installFetch([
    portalsRoute(ME),
    {
      match: (u) => u.pathname.endsWith("/mytasks/"),
      respond: () => ({ tasks: [task({ id: "t1", name: "T", projectId: MKT })] }),
    },
    {
      match: (u) => u.pathname.endsWith(`/portal/${PORTAL}/projects/`),
      respond: () => ({ projects: [{ id_string: MKT, name: "Marketing_SGS_Zoho", status: "active" }] }),
    },
    {
      match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
      respond: (u) =>
        u.searchParams.get("component_type") === "task"
          ? bucketed([timelog({ id: "L1", date: "05-09-2026", hours: "06:00", ownerId: ME })])
          : bucketed([]),
    },
    {
      match: (u, i) => i.method === "GET" && /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
      respond: () => bucketed([]),
    },
  ]);
  const { zoho, server } = await loadModules();
  zoho.resetDateWarningForTests();
  const mcp = server.createServer();

  const { data } = await callTool(mcp, "get_timesheet_status", {
    date_from: "2026-09-01",
    date_to: "2026-09-07",
    include_entries: true,
  });

  assert.equal(data.total_hours_found, 6, "the hours must not fall out of the range");
  assert.equal(data.entries[0].date, "2026-09-05");
});

test("the concurrency limiter never exceeds its ceiling under a rush", async () => {
  let inFlight = 0;
  let peak = 0;
  installFetch([
    {
      match: () => true,
      respond: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { projects: [] };
      },
    },
  ]);
  const { zoho } = await loadModules();

  // 20 callers against ZOHO_MAX_CONCURRENCY=3.
  await Promise.all(Array.from({ length: 20 }, () => zoho.listProjects(true)));

  assert.ok(peak <= 3, `peak concurrency was ${peak}, limit is 3`);
});
