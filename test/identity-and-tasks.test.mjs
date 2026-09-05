/**
 * Identity, task assignment and multi-user isolation.
 *
 * The reported failure started here: create_task did not actually assign the
 * task to the caller, so /mytasks/ stayed empty and every read that begins
 * with "my tasks" went blind.
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
const COLLEAGUE = "60067235894";

afterEach(() => mock.restoreAll());

const MY_OWNER = {
  zpuid: "283967000004030675",
  id: ME,
  email: "shweta@usaindiacfo.com",
  name: "Shweta Ramani",
};
const THEIR_OWNER = {
  zpuid: "283967000004391146",
  id: COLLEAGUE,
  email: "lakshya@usaindiacfo.com",
  name: "Lakshya Dadhich",
};

function baseRoutes({ loginId = ME, createdOwners = [MY_OWNER], myTasks = [] } = {}) {
  return [
    portalsRoute(loginId),
    { match: (u) => u.pathname.endsWith("/mytasks/"), respond: () => ({ tasks: myTasks }) },
    {
      match: (u) => u.pathname.endsWith(`/portal/${PORTAL}/projects/`),
      respond: () => ({ projects: [{ id_string: MKT, name: "Marketing_SGS_Zoho", status: "active" }] }),
    },
    {
      match: (u, i) => i.method === "POST" && /\/projects\/[^/]+\/tasks\/$/.test(u.pathname),
      respond: (u, init) => ({
        tasks: [
          task({
            id: "new1",
            name: init.body ? new URLSearchParams(String(init.body)).get("name") : "New",
            projectId: MKT,
            owners: createdOwners,
          }),
        ],
      }),
    },
    {
      match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
      respond: () => bucketed([]),
    },
    {
      match: (u, i) => i.method === "GET" && /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
      respond: () => bucketed([]),
    },
  ];
}

test("the caller's Zoho user id comes from /portals/ login_id", async () => {
  installFetch(baseRoutes());
  const { zoho, context } = await loadModules();

  const id = await zoho.ensureCallerUserId();
  assert.equal(id, ME);
  assert.equal(context.effective().timelogOwnerId, ME);
  assert.equal(zoho.callerIsIdentified(), true);
});

test("create_task assigns the task to the caller by user id, not by zpuid", async () => {
  const fetchMock = installFetch(baseRoutes());
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { text, data, isError } = await callTool(mcp, "create_task", {
    project_id: MKT,
    name: "Timesheet automation",
  });

  assert.equal(isError, false);
  const post = fetchMock.calls.find((c) => c.method === "POST" && c.path.endsWith("/tasks/"));
  assert.equal(
    post.body.person_responsible,
    ME,
    "must send the Zoho user id; omitting it leaves the task unassigned",
  );
  assert.ok(text.includes("Assigned to you"));
  assert.equal(data.assigned_to_caller, true);
});

test("create_task says loudly when Zoho assigned the task to somebody else", async () => {
  // This is the ZD1-T5 shape: created through the API, owned by a colleague.
  installFetch(baseRoutes({ createdOwners: [THEIR_OWNER] }));
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { text, data } = await callTool(mcp, "create_task", { project_id: MKT, name: "Thing" });

  assert.ok(/WARNING/.test(text));
  assert.ok(/did NOT assign it to you/.test(text));
  assert.ok(/assign_to_me/.test(text), "tells the user how to repair it");
  assert.equal(data.assigned_to_caller, false);
  assert.equal(data.mine, false);
});

test("a task created for someone else never teaches the server who the caller is", async () => {
  // The old code learned the caller's id from owners[0] of a created task,
  // which is how a colleague's id could be stored as yours.
  installFetch(baseRoutes({ loginId: "", createdOwners: [THEIR_OWNER] }));
  const { server, context } = await loadModules();
  const mcp = server.createServer();

  const { isError, text } = await callTool(mcp, "create_task", { project_id: MKT, name: "Thing" });

  assert.equal(isError, true, "with no identity it refuses rather than guessing");
  assert.ok(/Cannot tell which Zoho user/.test(text));
  assert.notEqual(context.effective().timelogOwnerId, COLLEAGUE);
  assert.equal(context.effective().timelogOwnerId, "");
});

test("create_task explains a rejected assignment instead of repeating Zoho's code", async () => {
  const routes = baseRoutes();
  routes[3] = {
    match: (u, i) => i.method === "POST" && /\/projects\/[^/]+\/tasks\/$/.test(u.pathname),
    respond: () =>
      json({ error: { code: 6401, message: "The user assigned does not belong to this project" } }, 400),
  };
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { text, isError } = await callTool(mcp, "create_task", { project_id: MKT, name: "Thing" });

  assert.equal(isError, true);
  assert.ok(/not a member of project/.test(text));
  assert.ok(/Nothing was created/.test(text));
});

test("owner_ids given as a zpuid is diagnosed as the wrong id space", async () => {
  const routes = baseRoutes();
  routes[3] = {
    match: (u, i) => i.method === "POST" && /\/projects\/[^/]+\/tasks\/$/.test(u.pathname),
    respond: () =>
      json({ error: { code: 6401, message: "The user assigned does not belong to this project" } }, 400),
  };
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { text } = await callTool(mcp, "create_task", {
    project_id: MKT,
    name: "Thing",
    owner_ids: ["283967000004030675"],
  });

  assert.ok(/look like zpuids/.test(text));
  assert.ok(/timelog_owner_id/.test(text));
});

test("update_task assign_to_me repairs a task Zoho assigned elsewhere", async () => {
  const routes = baseRoutes();
  routes.push({
    match: (u, i) => i.method === "POST" && /\/tasks\/[^/]+\/$/.test(u.pathname),
    respond: () => ({ tasks: [task({ id: "new1", name: "Thing", owners: [MY_OWNER] })] }),
  });
  const fetchMock = installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { text } = await callTool(mcp, "update_task", {
    task_id: "new1",
    project_id: MKT,
    assign_to_me: true,
  });

  const post = fetchMock.calls.find((c) => c.method === "POST" && /\/tasks\/new1\/$/.test(c.path));
  assert.equal(post.body.person_responsible, ME);
  assert.ok(/now assigned to you/.test(text));
});

test("include_others lists everyone's tasks instead of silently filtering them all away", async () => {
  // The regression: getTasks filtered the include_others pool down to the
  // caller's LOGIN zpuid, which never matches a task owner record, so the
  // tool returned [] on a project full of tasks.
  const routes = baseRoutes();
  routes.push({
    match: (u, i) => i.method === "GET" && /\/projects\/[^/]+\/tasks\/$/.test(u.pathname),
    respond: (u) =>
      Number(u.searchParams.get("index")) > 1
        ? { tasks: [] }
        : {
            tasks: [
              task({ id: "a", name: "Mine", owners: [MY_OWNER] }),
              task({ id: "b", name: "Theirs", owners: [THEIR_OWNER] }),
              task({ id: "c", name: "Unassigned", owners: [] }),
            ],
          },
  });
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data } = await callTool(mcp, "get_my_tasks", {
    include_others: true,
    include_completed: true,
    project_name: "Marketing",
  });

  assert.equal(data.length, 3);
  assert.deepEqual(
    data.map((t) => [t.task_name, t.mine]),
    [
      ["Mine", true],
      ["Theirs", false],
      ["Unassigned", false],
    ],
  );
});

test("ownership is null, not false, when the caller cannot be identified", async () => {
  const routes = baseRoutes({ loginId: "" });
  routes[1] = {
    match: (u) => u.pathname.endsWith("/mytasks/"),
    respond: () => ({ tasks: [task({ id: "a", name: "Mine", owners: [MY_OWNER] })] }),
  };
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, text } = await callTool(mcp, "get_my_tasks", { include_completed: true });

  assert.equal(data[0].mine, null, "unknown ownership must not be reported as 'not yours'");
  assert.ok(/could not be determined/.test(text));
});

test("a timelog write reveals the caller's id on their own request, not in module state", async () => {
  const routes = baseRoutes({ loginId: "" });
  routes[1] = {
    match: (u) => u.pathname.endsWith("/mytasks/"),
    respond: () => ({ tasks: [task({ id: "t1", name: "Work Review", owners: [MY_OWNER] })] }),
  };
  routes.push({
    match: (u, i) => i.method === "POST" && /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
    respond: () => ({ timelogs: { tasklogs: [timelog({ id: "L1", date: "09-01-2026", ownerId: ME })] } }),
  });
  installFetch(routes);
  const { server, context, zoho } = await loadModules();

  const ctxA = {
    zpuid: "zA",
    portalUserId: "",
    portalId: PORTAL,
    refreshToken: "1000.refresh",
    email: "a@x.com",
    name: "A",
  };
  const ctxB = {
    zpuid: "zB",
    portalUserId: "",
    portalId: PORTAL,
    refreshToken: "1000.refresh",
    email: "b@x.com",
    name: "B",
  };

  const mcp = server.createServer();
  await context.runWithUser(ctxA, async () => {
    await callTool(mcp, "log_time", {
      task_id: "t1",
      project_id: MKT,
      hours: 1,
      date: "2026-09-01",
    });
  });

  assert.equal(ctxA.portalUserId, ME, "A learns their own id");
  assert.equal(ctxA.discovered?.ownerId, ME);
  assert.equal(ctxB.portalUserId, "", "B must not inherit A's identity");
  assert.equal(ctxB.discovered, undefined);
  // And the projects A wrote to are recorded on A's context only.
  assert.deepEqual([...(ctxA.discovered?.projects.keys() ?? [])], [MKT]);
});

test("a write stamped with a different user id is reported, not silently adopted", async () => {
  const routes = baseRoutes();
  routes[1] = {
    match: (u) => u.pathname.endsWith("/mytasks/"),
    respond: () => ({ tasks: [task({ id: "t1", name: "Work Review", owners: [MY_OWNER] })] }),
  };
  routes.push({
    match: (u, i) => i.method === "POST" && /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
    respond: () => ({
      timelogs: {
        tasklogs: [timelog({ id: "L1", date: "09-01-2026", ownerId: COLLEAGUE, ownerName: "Lakshya" })],
      },
    }),
  });
  installFetch(routes);
  const { server, context } = await loadModules();
  const mcp = server.createServer();

  const { text } = await callTool(mcp, "log_time", {
    task_id: "t1",
    project_id: MKT,
    hours: 1,
    date: "2026-09-01",
  });

  assert.ok(/WARNING/.test(text));
  assert.ok(text.includes(COLLEAGUE) && text.includes(ME));
  assert.equal(
    context.effective().timelogOwnerId,
    ME,
    "a disagreeing write must not overwrite a known identity",
  );
});

test("the duplicate guard names whose entry blocked the write when identity is unknown", async () => {
  const routes = baseRoutes({ loginId: "" });
  routes[1] = {
    match: (u) => u.pathname.endsWith("/mytasks/"),
    respond: () => ({ tasks: [task({ id: "t1", name: "Work Review", owners: [MY_OWNER] })] }),
  };
  routes[5] = {
    match: (u, i) => i.method === "GET" && /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
    respond: () =>
      bucketed([timelog({ id: "L9", date: "09-01-2026", ownerId: COLLEAGUE, ownerName: "Lakshya Dadhich" })]),
  };
  installFetch(routes);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { text, isError } = await callTool(mcp, "log_time", {
    task_id: "t1",
    project_id: MKT,
    hours: 1,
    date: "2026-09-01",
  });

  assert.equal(isError, true);
  assert.ok(/Lakshya Dadhich/.test(text), "says whose entry it is");
  assert.ok(/cannot be confirmed as/.test(text));
});

test("task logs are paginated, so an old entry cannot hide behind page one", async () => {
  const page1 = Array.from({ length: 200 }, (_, i) =>
    timelog({ id: `p1-${i}`, date: "01-15-2026", ownerId: ME }),
  );
  const page2 = [timelog({ id: "p2-0", date: "09-01-2026", ownerId: ME })];
  const routes = baseRoutes();
  routes[5] = {
    match: (u, i) => i.method === "GET" && /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
    respond: (u) => bucketed(Number(u.searchParams.get("index")) > 1 ? page2 : page1),
  };
  installFetch(routes);
  const { zoho } = await loadModules();

  const logs = await zoho.fetchTaskLogs({
    task_id: "t1",
    project_id: MKT,
    task_name: "T",
    project_name: "P",
  });

  assert.equal(logs.length, 201);
  assert.ok(logs.some((l) => l.log_id === "p2-0"), "the second page was read");
});

test("an unexpected day/month order in a Zoho date is repaired, not dropped", async () => {
  const routes = baseRoutes();
  routes[5] = {
    match: (u, i) => i.method === "GET" && /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
    // 26-08-2026 is dd-MM-yyyy; read as MM-dd-yyyy it would be month 26.
    respond: () => bucketed([timelog({ id: "L1", date: "26-08-2026", ownerId: ME })]),
  };
  installFetch(routes);
  const { zoho } = await loadModules();

  const logs = await zoho.fetchTaskLogs({
    task_id: "t1",
    project_id: MKT,
    task_name: "T",
    project_name: "P",
  });

  assert.equal(logs[0].date, "2026-08-26");
});

test("audit records name the acting identity", async () => {
  installFetch(baseRoutes());
  const { server } = await loadModules();
  const mcp = server.createServer();

  const lines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  try {
    await callTool(mcp, "create_task", { project_id: MKT, name: "Audited" });
  } finally {
    process.stderr.write = origWrite;
  }

  const auditLine = lines.find((l) => l.includes("AUDIT created"));
  assert.ok(auditLine, "a create is audited");
  const record = JSON.parse(auditLine.slice(auditLine.indexOf("{")));
  assert.equal(record.actor.user_id, ME);
  assert.equal(record.actor.mode, "service-account");
  assert.equal(record.resolved.project_id, MKT);
});
