/**
 * An error that is safe and useful to hand back to the model/user verbatim.
 * Anything thrown as a ZohoError gets surfaced as a readable tool result
 * instead of a stack trace.
 */
export class ZohoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string | number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ZohoError";
  }

  toDisplay(): string {
    const parts = [this.message];
    if (this.code !== undefined) parts.push(`(Zoho code ${this.code})`);
    if (this.hint) parts.push(`\nWhat to do: ${this.hint}`);
    return parts.join(" ");
  }
}

/** Maps Zoho's terse error payloads onto something actionable. */
export function describeZohoError(status: number, body: string): ZohoError {
  let code: string | number | undefined;
  let message: string | undefined;

  try {
    const json = JSON.parse(body);
    const err = json.error ?? json;
    code = err.code ?? err.error_code ?? err.title;
    // Newer Zoho errors nest the human-readable text under details.
    message = err.message ?? err.details?.message ?? err.error_message ?? json.message;
  } catch {
    /* non-JSON body; fall through to the raw text */
  }

  const base = message ?? body.slice(0, 400) ?? "Unknown Zoho error";

  const hints: Record<string, string> = {
    "6401":
      "Zoho's generic bad-request code: the id may not exist in this portal, the account may " +
      "not be able to see it, or a user id passed is not a member of the project.",
    "6501": "This portal id is not valid for the authenticated account. Check ZOHO_PORTAL_ID.",
    "6831": "The timelog payload was rejected. Check hours format (HH:MM), date format, and bill_status.",
    "6834": "Logging time on this task is not permitted — the task may be closed, or timesheet entry is restricted for this user.",
    "6886": "The user is not a member of this project, so time cannot be logged against it.",
  };

  let hint = code !== undefined ? hints[String(code)] : undefined;

  if (!hint && /THROTTLE/i.test(String(code))) {
    hint =
      "Zoho's rolling per-endpoint limit (100 requests / 2 minutes) was hit. " +
      "Avoid include_others on large portals; it scans one project at a time.";
  }

  if (!hint) {
    if (status === 401) {
      hint = "Authentication failed. The refresh token may have been revoked, or ZOHO_DOMAIN may not match the account's data centre.";
    } else if (status === 403) {
      hint = "Permission denied. The service account lacks access to this portal/project, or the OAuth scopes are missing ZohoProjects.timesheets.ALL.";
    } else if (status === 404) {
      hint = "Endpoint or record not found. Verify the portal, project, and task ids.";
    } else if (status === 429) {
      hint = "Zoho rate limit hit. Wait a minute and retry.";
    }
  }

  return new ZohoError(base, status, code, hint);
}
