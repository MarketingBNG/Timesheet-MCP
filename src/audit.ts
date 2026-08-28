import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Append-only JSONL audit trail. Every write attempt is recorded — including
 * the ones that were refused or failed — because this server bypasses the
 * Zoho UI and the refusals are the interesting half of the record.
 */

export type AuditOutcome =
  | "created"
  | "deleted"
  | "refused_ambiguous"
  | "refused_no_match"
  | "refused_duplicate"
  | "dry_run"
  | "error";

export interface AuditEntry {
  timestamp: string;
  outcome: AuditOutcome;
  requested: Record<string, unknown>;
  resolved?: Record<string, unknown>;
  candidates?: Array<{ task_id: string; task_name: string; project_name: string; score: number }>;
  error?: string;
}

let warnedAboutFile = false;

export function audit(entry: Omit<AuditEntry, "timestamp">): void {
  const record: AuditEntry = { timestamp: new Date().toISOString(), ...entry };
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
