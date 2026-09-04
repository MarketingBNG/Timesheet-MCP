import { config } from "./config.js";
import { getAccessToken, invalidateAndRefresh } from "./auth.js";
import { currentUser } from "./context.js";
import { ZohoError } from "./errors.js";
import { log } from "./logger.js";
import { assertIsoDate, fromPortalDate, toPortalDate } from "./format.js";

/**
 * Zoho People attendance — the check-in / check-out side of the day.
 *
 * People is a different product from Projects: a different host, a different
 * id space (an employee record, not a zpuid), and its own dateFormat
 * parameter. The OAuth application is the same one, so the access token is
 * shared; only the scope had to grow. A token minted before
 * ZohoPeople.attendance.READ was added still works for everything else and
 * fails here with a 403, which is translated into "reconnect" rather than
 * surfacing as a bare permission error.
 */

/** People takes an explicit dateFormat, so we pin one rather than guess. */
const PEOPLE_DATE_FORMAT = "dd-MM-yyyy";

const peopleBase = `https://people.zoho.${config.domain}/people/api`;

const REQUEST_TIMEOUT_MS = Number(process.env.ZOHO_TIMEOUT_MS ?? 30_000);

async function peopleRequest<T = any>(
  path: string,
  query: Record<string, string | undefined> = {},
): Promise<T> {
  const url = new URL(`${peopleBase}/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  let retriedAuth = false;

  for (;;) {
    const token = await getAccessToken();
    log.debug(`GET ${url.toString()}`);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new ZohoError(
        timedOut
          ? `Zoho People did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`
          : `Could not reach Zoho People: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = await res.text();

    if (res.status === 401 && !retriedAuth) {
      retriedAuth = true;
      await invalidateAndRefresh();
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw new ZohoError(
        "Zoho People refused the request.",
        res.status,
        undefined,
        "The connected token is probably missing ZohoPeople.attendance.READ. " +
          "Reconnect the Zoho account so the new scope is granted.",
      );
    }

    if (!res.ok) {
      throw new ZohoError(
        `Zoho People returned HTTP ${res.status}.`,
        res.status,
        undefined,
        text.slice(0, 200),
      );
    }

    if (!text.trim()) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ZohoError(
        `Zoho People returned a response that was not JSON (HTTP ${res.status}).`,
        res.status,
        undefined,
        text.slice(0, 200),
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * People identifies people by their employee record, which is a THIRD id
 * space — neither the zpuid that owns tasks nor the 600... id that owns
 * timelogs. Email is the only thing the two products reliably share, so that
 * is what we bridge on.
 */
export interface Employee {
  employeeId: string;
  email: string;
  name: string;
}

const employeeCache = new Map<string, Promise<Employee>>();

/**
 * The email to look the employee record up by, or "" when an explicit
 * employee id makes the lookup unnecessary.
 */
async function callerEmail(): Promise<string> {
  const stored = currentUser()?.email?.trim();
  if (stored) return stored;

  // An explicit employee id makes the lookup unnecessary.
  if (config.peopleEmployeeId) return "";

  // The stored email is filled in from the Projects side, which needs either
  // admin rights or at least one owned task — so a new Team Member has none.
  // Their own token can always answer the question directly, no extra scope
  // and no task ownership required.
  const email = await emailFromToken();
  if (email) return email;

  throw new ZohoError(
    "Cannot tell which employee to read attendance for.",
    undefined,
    undefined,
    "In OAuth mode this comes from the connected account — try reconnecting. " +
      "Running as a service account, set ZOHO_PEOPLE_EMPLOYEE_ID to the employee " +
      "id whose attendance should be read.",
  );
}

/** The signed-in user's email, straight from the token that identifies them. */
async function emailFromToken(): Promise<string> {
  try {
    const token = await getAccessToken();
    const res = await fetch(`${config.accountsBase}/oauth/user/info`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return "";
    const json: any = await res.json().catch(() => ({}));
    return String(json?.Email ?? json?.email ?? "").trim();
  } catch (err) {
    // Best effort — the caller has a clearer error to raise than this one.
    log.warn("could not read the account email from the token", String(err));
    return "";
  }
}

export async function resolveEmployee(): Promise<Employee> {
  const email = await callerEmail();

  // An explicit employee id short-circuits the lookup entirely, which is the
  // only way this works for a service account with no email of its own.
  if (!email) {
    return Promise.resolve({
      employeeId: config.peopleEmployeeId,
      email: "",
      name: `employee ${config.peopleEmployeeId}`,
    });
  }

  const cached = employeeCache.get(email);
  if (cached) return cached;

  const pending = (async () => {
    const json = await peopleRequest<any>("forms/employee/getRecords", {
      searchParams: JSON.stringify({
        searchField: "EMAILID",
        searchOperator: "Is",
        searchText: email,
      }),
    });

    // People wraps records in nested objects rather than a flat array, and the
    // shape differs between the getRecords variants, so accept both.
    const raw = json?.response?.result ?? json?.result ?? [];
    const records: any[] = Array.isArray(raw) ? raw : Object.values(raw);
    const flat = records.flatMap((r) =>
      Array.isArray(r) ? r : r && typeof r === "object" ? Object.values(r).flat() : [],
    );

    const match = flat.find(
      (r) => r && typeof r === "object" && !Array.isArray(r),
    ) as Record<string, any> | undefined;

    if (!match) {
      throw new ZohoError(
        `No Zoho People employee record matches ${email}.`,
        undefined,
        undefined,
        "Attendance is read per employee record. If the People account uses a " +
          "different email from Projects, set ZOHO_PEOPLE_EMPLOYEE_ID explicitly.",
      );
    }

    const employeeId = String(
      match["EmployeeID"] ?? match["Employee ID"] ?? match["employeeId"] ?? "",
    ).trim();

    if (!employeeId) {
      throw new ZohoError(
        `The Zoho People record for ${email} has no employee id.`,
        undefined,
        undefined,
        // The field names, never the values — this is HR data.
        `Fields present: ${Object.keys(match).slice(0, 12).join(", ")}`,
      );
    }

    const first = String(match["FirstName"] ?? "").trim();
    const last = String(match["LastName"] ?? "").trim();

    return {
      employeeId,
      email,
      name: [first, last].filter(Boolean).join(" ") || email,
    };
  })();

  employeeCache.set(email, pending);
  // A failed lookup must not stay cached, or one transient error becomes
  // permanent for the life of the process.
  pending.catch(() => employeeCache.delete(email));
  return pending;
}

/* ------------------------------------------------------------------ *
 * Attendance
 * ------------------------------------------------------------------ */

export interface AttendanceDay {
  date: string;
  /** First punch in, as People reports it. Null on a day with no attendance. */
  checkIn: string | null;
  checkOut: string | null;
  /**
   * Hours actually worked, from People's own total. Deliberately NOT
   * checkOut - checkIn: that span includes lunch and every other break, and
   * logging it would overstate the day by about an hour.
   */
  hours: number;
  /** People's own status — Present, Absent, Weekend, Holiday, Leave... */
  status: string;
}

/** People reports durations as "08:30", and in some fields as "8.5". */
function parseDuration(value: unknown): number {
  const s = String(value ?? "").trim();
  if (!s) return 0;
  const hhmm = /^(\d{1,3}):(\d{2})$/.exec(s);
  if (hhmm) return Number(hhmm[1]) + Number(hhmm[2]) / 60;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Attendance over a date range for the calling user.
 *
 * `days` is the caller's already-validated ISO day list. Days People says
 * nothing about come back explicitly as zero rather than being dropped — a
 * missing day and a zero-hour day mean different things to the caller.
 */
export async function getAttendance(
  fromIso: string,
  toIso: string,
  days: string[],
): Promise<{ employee: Employee; days: AttendanceDay[] }> {
  assertIsoDate(fromIso, "date_from");
  assertIsoDate(toIso, "date_to");

  const employee = await resolveEmployee();

  const json = await peopleRequest<any>("attendance/getUserReport", {
    empId: employee.employeeId,
    sdate: toPortalDate(fromIso, PEOPLE_DATE_FORMAT),
    edate: toPortalDate(toIso, PEOPLE_DATE_FORMAT),
    dateFormat: PEOPLE_DATE_FORMAT,
  });

  // The payload is keyed by date string, with a little envelope noise mixed in
  // at the same level, so entries are picked by what parses as a date rather
  // than by position.
  const source = json?.response?.result ?? json?.result ?? json ?? {};
  const byDate = new Map<string, AttendanceDay>();

  for (const [key, value] of Object.entries(source as Record<string, any>)) {
    const iso = fromPortalDate(key, PEOPLE_DATE_FORMAT);
    if (!iso || !value || typeof value !== "object") continue;
    const v: any = Array.isArray(value) ? (value[0] ?? {}) : value;

    byDate.set(iso, {
      date: iso,
      checkIn: String(v.FirstIn ?? v.firstIn ?? "").trim() || null,
      checkOut: String(v.LastOut ?? v.lastOut ?? "").trim() || null,
      hours: Number(
        parseDuration(v.TotalHours ?? v.totalHours ?? v.WorkingHours).toFixed(2),
      ),
      status: String(v.Status ?? v.status ?? "").trim(),
    });
  }

  return {
    employee,
    days: days.map(
      (d) =>
        byDate.get(d) ?? {
          date: d,
          checkIn: null,
          checkOut: null,
          hours: 0,
          status: "No data",
        },
    ),
  };
}
