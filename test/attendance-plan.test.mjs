/**
 * The attendance side of the same defect: People returning nothing must not
 * become "0 hours of attendance", and a timesheet that could not be read must
 * not become a shortfall the model is told to file.
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

/** Zoho People's attendance report, keyed by dd-MM-yyyy. */
function peopleRoute(byDate) {
  return {
    match: (u) => u.hostname.startsWith("people."),
    respond: () => ({ response: { result: byDate } }),
  };
}

function routes({ people, myTasks = [task({ id: "t1", name: "Work Review", projectId: MKT })], logs = [] } = {}) {
  return [
    portalsRoute(ME),
    { match: (u) => u.pathname.includes("/oauth/user/info"), respond: () => ({ Email: "shweta@usaindiacfo.com" }) },
    people,
    { match: (u) => u.pathname.endsWith("/mytasks/"), respond: () => ({ tasks: myTasks }) },
    {
      match: (u) => u.pathname.endsWith(`/portal/${PORTAL}/projects/`),
      respond: () => ({ projects: [{ id_string: MKT, name: "Marketing_SGS_Zoho", status: "active" }] }),
    },
    {
      match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
      respond: (u) => (u.searchParams.get("component_type") === "task" ? bucketed(logs) : bucketed([])),
    },
    {
      match: (u, i) => i.method === "GET" && /\/tasks\/[^/]+\/logs\/$/.test(u.pathname),
      respond: () => bucketed([]),
    },
  ];
}

test("attendance that parses to nothing is undetermined, not zero hours", async () => {
  installFetch(routes({ people: peopleRoute({ someOtherShape: true }) }));
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { text, data, isError } = await callTool(mcp, "get_attendance", {
    date_from: "2026-09-01",
    date_to: "2026-09-02",
  });

  assert.equal(isError, true);
  assert.equal(data.reason_code, "attendance_unavailable");
  assert.ok(!/0\.00h of attendance/.test(text));
});

test("plan_timesheet refuses to plan when People said nothing", async () => {
  installFetch(routes({ people: peopleRoute({}) }));
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { text, data, isError } = await callTool(mcp, "plan_timesheet_from_attendance", {
    date_from: "2026-09-01",
    date_to: "2026-09-02",
  });

  assert.equal(isError, true);
  assert.equal(data.reason_code, "attendance_unavailable");
  assert.ok(!/fully reflected/.test(text), "must not claim the timesheet is complete");
});

test("a real shortfall is proposed, and hours already logged are subtracted", async () => {
  installFetch(
    routes({
      people: peopleRoute({
        "01-09-2026": { FirstIn: "09:30 AM", LastOut: "07:00 PM", TotalHours: "08:00", Status: "Present" },
        "02-09-2026": { FirstIn: "09:45 AM", LastOut: "06:30 PM", TotalHours: "07:30", Status: "Present" },
      }),
      logs: [timelog({ id: "L1", date: "09-01-2026", hours: "03:00", ownerId: ME })],
    }),
  );
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, text, isError } = await callTool(mcp, "plan_timesheet_from_attendance", {
    date_from: "2026-09-01",
    date_to: "2026-09-02",
  });

  assert.equal(isError, false);
  assert.equal(data.wrote_to_zoho, false);
  const [d1, d2] = data.per_day;
  assert.deepEqual([d1.attendance_hours, d1.already_logged_hours, d1.hours_to_log], [8, 3, 5]);
  assert.deepEqual([d2.already_logged_hours, d2.hours_to_log], [0, 7.5]);
  assert.ok(/Nothing has been written/.test(text));

  // This portal has a single project and it was read in full, so the shortfall
  // is a fact and may be acted on.
  assert.equal(data.already_logged_is_complete, true);
  assert.equal(d1.already_logged_is_confirmed, true);
  assert.equal(d1.safe_to_file_without_asking, true);
  assert.equal(d1.needs_task, true);
  assert.deepEqual(data.days_shortfall_unconfirmed, []);
  assert.ok(!/MAXIMUM, not a fact/.test(text));
});

test("on a portal too large to read in full, the shortfall is a maximum, not a fact", async () => {
  // The dangerous case: hours found in the one project we could read, but 348
  // others unread. Filing the difference could double-log a day.
  const r = routes({
    people: peopleRoute({
      "01-09-2026": { FirstIn: "09:30 AM", LastOut: "07:00 PM", TotalHours: "08:00", Status: "Present" },
    }),
    logs: [timelog({ id: "L1", date: "09-01-2026", hours: "03:00", ownerId: ME })],
  });
  r[4] = {
    match: (u) => u.pathname.endsWith(`/portal/${PORTAL}/projects/`),
    respond: (u) =>
      Number(u.searchParams.get("index")) > 1
        ? { projects: [] }
        : {
            projects: [
              { id_string: MKT, name: "Marketing_SGS_Zoho", status: "active" },
              ...Array.from({ length: 348 }, (_, i) => ({
                id_string: `p${i}`,
                name: `Project ${i}`,
                status: "active",
              })),
            ],
          },
  };
  installFetch(r);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, text } = await callTool(mcp, "plan_timesheet_from_attendance", {
    date_from: "2026-09-01",
    date_to: "2026-09-01",
  });

  const day = data.per_day[0];
  assert.equal(day.already_logged_hours, 3, "what was found is still reported");
  assert.equal(day.hours_to_log, 5, "and the gap is still computed");
  assert.equal(data.already_logged_is_complete, false);
  assert.equal(day.already_logged_is_confirmed, false);
  assert.equal(day.safe_to_file_without_asking, false, "but it must not be filed unasked");
  assert.equal(day.needs_task, null);
  assert.deepEqual(data.days_shortfall_unconfirmed, ["2026-09-01"]);
  assert.ok(/MAXIMUM, not a fact/.test(text));
  assert.ok(/could duplicate entries/.test(text));
});

test("a day whose timesheet could not be read gets a null shortfall, never a number to file", async () => {
  const r = routes({
    people: peopleRoute({
      "01-09-2026": { FirstIn: "09:30 AM", LastOut: "07:00 PM", TotalHours: "08:00", Status: "Present" },
    }),
  });
  r[5] = {
    match: (u) => /\/projects\/[^/]+\/logs\/$/.test(u.pathname),
    respond: () => json({ error: { code: 6831, message: "nope" } }, 400),
  };
  installFetch(r);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, text } = await callTool(mcp, "plan_timesheet_from_attendance", {
    date_from: "2026-09-01",
    date_to: "2026-09-01",
  });

  const day = data.per_day[0];
  assert.equal(day.attendance_hours, 8, "attendance is still a fact");
  assert.equal(day.already_logged_is_confirmed, false);
  assert.equal(day.safe_to_file_without_asking, false);
  assert.equal(day.needs_task, null, "an unconfirmed shortfall is not a fact");
  assert.ok(/MAXIMUM, not a fact/.test(text));
});

test("with no readable project the plan still reports attendance, with the logged side unknown", async () => {
  const r = routes({
    people: peopleRoute({
      "01-09-2026": { FirstIn: "09:30 AM", LastOut: "07:00 PM", TotalHours: "08:00", Status: "Present" },
    }),
    myTasks: [],
  });
  // A big portal: nothing to scan, and no writes remembered.
  r[4] = {
    match: (u) => u.pathname.endsWith(`/portal/${PORTAL}/projects/`),
    respond: (u) =>
      Number(u.searchParams.get("index")) > 1
        ? { projects: [] }
        : {
            projects: Array.from({ length: 349 }, (_, i) => ({
              id_string: `p${i}`,
              name: `Project ${i}`,
              status: "active",
            })),
          },
  };
  installFetch(r);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, text, isError } = await callTool(mcp, "plan_timesheet_from_attendance", {
    date_from: "2026-09-01",
    date_to: "2026-09-01",
  });

  assert.equal(isError, false, "attendance is real even when the timesheet cannot be read");
  assert.equal(data.per_day[0].hours_to_log, null, "no shortfall may be computed from nothing");
  assert.equal(data.per_day[0].safe_to_file_without_asking, false);
  assert.deepEqual(data.days_timesheet_unknown, ["2026-09-01"]);
  assert.ok(/could NOT be read at all/.test(text));
  assert.ok(/Do not file for them/.test(text));
  assert.ok(!/fully reflected/.test(text));
});

test("plan_timesheet refuses outright when the Zoho user cannot be identified", async () => {
  const r = routes({
    people: peopleRoute({
      "01-09-2026": { FirstIn: "09:30 AM", LastOut: "07:00 PM", TotalHours: "08:00", Status: "Present" },
    }),
  });
  r[0] = portalsRoute("");
  installFetch(r);
  const { server } = await loadModules();
  const mcp = server.createServer();

  const { data, isError } = await callTool(mcp, "plan_timesheet_from_attendance", {
    date_from: "2026-09-01",
    date_to: "2026-09-01",
  });

  assert.equal(isError, true);
  assert.equal(data.reason_code, "identity_unknown");
});
