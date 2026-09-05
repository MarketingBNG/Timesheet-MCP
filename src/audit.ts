import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { currentUser, effective } from "./context.js";
import { log } from "./logger.js";

/**
 * Append-only JSONL audit trail. Every write attempt is recorded — including
 * the ones that were refused or failed — because this server bypasses the
 * Zoho UI and the refusals are the interesting half of the record.
 */

export type AuditOutcome =
  | "created"
  | "updated"
  | "deleted"
  | "refused_not_owner"
  | "refused_ambiguous"
  | "refused_no_match"
  | "refused_duplicate"
  | "dry_run"
  | "error";

export interface AuditActor {
  mode: "oauth" | "service-account";
  zpuid: string;
  /** Zoho user id (600...) the server believed the caller to be at the time. */
  user_id: string;
  email: string;
}

export interface AuditEntry {
  timestamp: string;
  /** Who the server was acting as. Without this an identity mix-up cannot be reconstructed. */
  actor: AuditActor;
  outcome: AuditOutcome;
  requested: Record<string, unknown>;
  resolved?: Record<string, unknown>;
  candidates?: Array<{ task_id: string; task_name: string; project_name: string; score: number }>;
  error?: string;
}

let warnedAboutFile = false;

function actor(): AuditActor {
  const eff = effective();
  return {
    mode: currentUser() ? "oauth" : "service-account",
    zpuid: eff.userId,
    user_id: eff.timelogOwnerId,
    email: eff.email,
  };
}

export function audit(entry: Omit<AuditEntry, "timestamp" | "actor">): void {
  const record: AuditEntry = { timestamp: new Date().toISOString(), actor: actor(), ...entry };
  const line = JSON.stringify(record);

  // Always mirror to stderr so it shows up in the Claude Desktop MCP log.
  log.info(`AUDIT ${record.outcome}`, line);

  try {
    fs.mkdirSync(path.dirname(config.auditFile), { recursive: true });
    fs.appendFileSync(config.auditFile, line + "\n", "utf8");
  } catch (err) {
    if (!warnedAboutFile) {
      warnedAboutFile = true;
      log.warn(
        `could not write the audit file at ${config.auditFile}; stderr-only from here`,
        String(err),
      );
    }
  }
}

/**
 * Project ids this audit file has seen writes to. The stdio server has no
 * database, so this is how a service account remembers, across restarts,
 * which projects its timesheet lives in.
 */
export function projectsFromAuditFile(): Map<string, string> {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = fs.readFileSync(config.auditFile, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as AuditEntry;
      if (!["created", "updated", "deleted"].includes(rec.outcome)) continue;
      const id = String(rec.resolved?.project_id ?? rec.requested?.project_id ?? "");
      if (!/^\d+$/.test(id)) continue;
      const name = String(rec.resolved?.project_name ?? "");
      if (!out.has(id) || (name && !out.get(id))) out.set(id, name);
    } catch {
      /* a corrupt line is not worth failing over */
    }
  }
  return out;
}
