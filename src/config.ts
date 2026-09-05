import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load .env sitting next to the package root (dist/../.env), not the CWD that
// Claude Desktop happens to spawn us in.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "..", ".env") });
loadEnv(); // also honour a CWD .env / real env vars

/**
 * Misconfiguration is not an exceptional condition worth a stack trace — it is
 * the single most likely reason this server fails to start, so say so plainly
 * on stderr and exit.
 */
/**
 * In OAuth mode each user brings their own credentials, so the service-account
 * variables are not needed. Only the Zoho application identity is.
 */
const oauthMode = Boolean(
  process.env.PUBLIC_URL?.trim() && process.env.TOKEN_ENCRYPTION_KEY?.trim(),
);

/** Required only when running as a single service account. */
function requiredUnlessOauth(name: string): string {
  return oauthMode ? (process.env[name]?.trim() ?? "") : required(name);
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    process.stderr.write(
      `\nzoho-timesheet: missing required environment variable ${name}.\n` +
        `Copy .env.example to .env next to the package and fill in:\n` +
        `  ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_PORTAL_ID, ZOHO_USER_ID\n` +
        `See the README for how to obtain each one.\n\n`,
    );
    process.exit(1);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

/** projects.zoho.com | .in | .eu | .com.au | .jp — must match the account's data centre. */
const domain = optional("ZOHO_DOMAIN", "com").replace(/^\.+/, "");

export const config = {
  clientId: required("ZOHO_CLIENT_ID"),
  clientSecret: required("ZOHO_CLIENT_SECRET"),
  refreshToken: requiredUnlessOauth("ZOHO_REFRESH_TOKEN"),
  portalId: requiredUnlessOauth("ZOHO_PORTAL_ID"),

  /** Zoho user (zpuid) whose tasks and timesheet this server acts on. */
  userId: requiredUnlessOauth("ZOHO_USER_ID"),

  domain,
  apiBase: `https://projects.zoho.${domain}/restapi`,
  accountsBase: `https://accounts.zoho.${domain}`,

  /**
   * The Zoho user id (a 600... value on this data centre): what timelogs carry
   * as owner_id, what task owner records carry as `id`, and what
   * person_responsible takes. A DIFFERENT id space from ZOHO_USER_ID. When
   * empty it is read from /portals/ login_id on first use.
   */
  timelogOwnerId: optional("ZOHO_TIMELOG_OWNER_ID", ""),

  /**
   * Zoho People employee id whose attendance is read. Only needed when running
   * as a service account: in OAuth mode the employee record is found from the
   * connected user's email instead.
   */
  peopleEmployeeId: optional("ZOHO_PEOPLE_EMPLOYEE_ID", ""),

  /** Billable | Non Billable — Zoho rejects timelog creation without one. */
  defaultBillStatus: optional("ZOHO_DEFAULT_BILL_STATUS", "Non Billable"),

  auditFile: optional(
    "AUDIT_LOG_PATH",
    path.resolve(here, "..", "audit", "timelog-audit.jsonl"),
  ),

  /** How long the task list is cached in memory, seconds. */
  taskCacheTtlSeconds: Number(optional("TASK_CACHE_TTL_SECONDS", "300")),

  /** Max concurrent outbound calls to Zoho. Their per-minute limits are low. */
  maxConcurrency: Number(optional("ZOHO_MAX_CONCURRENCY", "3")),
} as const;

export type Config = typeof config;
