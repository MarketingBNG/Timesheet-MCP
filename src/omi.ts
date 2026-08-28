import { ZohoError } from "./errors.js";
import { matchTask, type MatchResult } from "./match.js";
import type { Task } from "./zoho.js";

/**
 * Omi import — an optional, additive path.
 *
 * Nothing in this module talks to Zoho and nothing in it writes. It turns an
 * Omi conversations export into *proposed* timesheet entries and hands them
 * back for a human to approve. The core log_time flow does not import from
 * here, so a team member without Omi is unaffected by any of it.
 */

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

export interface OmiConversation {
  id: string;
  title: string;
  summary: string;
  category: string;
  startIso?: string;
  endIso?: string;
  /** Local calendar date, YYYY-MM-DD. */
  date?: string;
  /** Raw duration before rounding. */
  rawHours?: number;
  discarded: boolean;
}

/** Omi's export has moved around between versions; accept the known shapes. */
function extractArray(parsed: unknown): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["conversations", "memories", "results", "data", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as any[];
    }
  }
  throw new ZohoError(
    "Could not find a list of conversations in that JSON.",
    undefined,
    undefined,
    'Expected either a top-level array, or an object with a "conversations" (or "memories") array.',
  );
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Omi timestamps appear as ISO strings or epoch seconds/millis. */
function toIso(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Below ~10^11 it is seconds, above it is milliseconds.
    const ms = value < 100_000_000_000 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

/** Latest segment end offset, used when finished_at is absent. */
function segmentEndSeconds(segments: unknown): number | undefined {
  if (!Array.isArray(segments) || segments.length === 0) return undefined;
  let max = 0;
  for (const s of segments) {
    const end = Number(s?.end ?? s?.end_time ?? s?.offset_end);
    if (Number.isFinite(end)) max = Math.max(max, end);
  }
  return max > 0 ? max : undefined;
}

/** Calendar date of an instant, shifted by a UTC offset in minutes. */
function localDate(iso: string, utcOffsetMinutes: number): string {
  return new Date(Date.parse(iso) + utcOffsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);
}

export function parseOmiConversations(
  json: string,
  utcOffsetMinutes: number,
): OmiConversation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ZohoError(
      `conversations_json is not valid JSON: ${(err as Error).message}`,
      undefined,
      undefined,
      "Paste the raw export exactly as Omi produced it, without surrounding prose or markdown fences.",
    );
  }

  return extractArray(parsed).map((c, i) => {
    const structured = c?.structured ?? {};

    const startIso =
      toIso(c?.started_at) ?? toIso(c?.start_time) ?? toIso(c?.created_at) ?? toIso(c?.timestamp);

    let endIso = toIso(c?.finished_at) ?? toIso(c?.end_time) ?? toIso(c?.completed_at);

    // Fall back to the transcript's own length when no end timestamp exists.
    if (!endIso && startIso) {
      const secs = segmentEndSeconds(c?.transcript_segments ?? c?.segments);
      if (secs !== undefined) endIso = new Date(Date.parse(startIso) + secs * 1000).toISOString();
    }

    let rawHours: number | undefined;
    if (startIso && endIso) {
      const ms = Date.parse(endIso) - Date.parse(startIso);
      if (ms > 0) rawHours = ms / 3_600_000;
    }

    return {
      id: firstString(c?.id, c?.conversation_id, c?.uuid) || `conversation-${i + 1}`,
      title: firstString(structured?.title, c?.title, c?.name),
      summary: firstString(
        structured?.overview,
        structured?.summary,
        c?.overview,
        c?.summary,
        c?.text,
      ),
      category: firstString(structured?.category, c?.category, c?.emoji_category),
      startIso,
      endIso,
      date: startIso ? localDate(startIso, utcOffsetMinutes) : undefined,
      rawHours,
      discarded: c?.discarded === true,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Drafting
 * ------------------------------------------------------------------ */

export type DraftStatus = "ready" | "needs_review" | "skipped";

export interface DraftCandidate {
  task_id: string;
  task_name: string;
  project_name: string;
  score: number;
}

export interface Draft {
  conversation_id: string;
  conversation_summary: string;
  category: string;
  date?: string;
  hours?: number;
  started_at?: string;
  ended_at?: string;
  status: DraftStatus;
  /** Why it is not `ready`, when it is not. */
  reason?: string;
  confidence: "high" | "low" | "none";
  matched_task?: DraftCandidate;
  candidates?: DraftCandidate[];
}

export interface DraftOptions {
  /** Discard conversations shorter than this. Omi logs a lot of noise. */
  minMinutes: number;
  /** Round each duration up to this granularity, in minutes. 0 disables. */
  roundToMinutes: number;
  utcOffsetMinutes: number;
}

function view(task: Task, score: number): DraftCandidate {
  return {
    task_id: task.task_id,
    task_name: task.task_name,
    project_name: task.project_name,
    score: Number(score.toFixed(3)),
  };
}

function roundHours(hours: number, toMinutes: number): number {
  if (toMinutes <= 0) return Number(hours.toFixed(2));
  const step = toMinutes / 60;
  return Number((Math.round(hours / step) * step).toFixed(2));
}

/**
 * The text a conversation is matched on. Title first — Omi titles are short and
 * task-like, whereas overviews are prose and drag the matcher toward noise.
 */
function matchText(c: OmiConversation): string {
  return c.title || c.summary.slice(0, 120);
}

export function buildDrafts(
  conversations: OmiConversation[],
  tasks: Task[],
  opts: DraftOptions,
): Draft[] {
  return conversations.map((c) => {
    const base: Draft = {
      conversation_id: c.id,
      conversation_summary: c.title || c.summary.slice(0, 160) || "(untitled)",
      category: c.category,
      date: c.date,
      started_at: c.startIso,
      ended_at: c.endIso,
      confidence: "none",
      status: "skipped",
    };

    if (c.discarded) {
      return { ...base, reason: "Marked discarded in Omi." };
    }
    if (!c.date) {
      return { ...base, reason: "No usable start timestamp, so the date is unknown." };
    }
    if (c.rawHours === undefined) {
      return { ...base, reason: "No end timestamp or transcript length, so duration is unknown." };
    }
    if (c.rawHours * 60 < opts.minMinutes) {
      return {
        ...base,
        hours: Number(c.rawHours.toFixed(2)),
        reason: `Shorter than the ${opts.minMinutes}-minute floor.`,
      };
    }

    const hours = roundHours(c.rawHours, opts.roundToMinutes);
    if (hours <= 0) {
      return { ...base, reason: "Rounds to zero hours." };
    }

    const text = matchText(c);
    if (!text) {
      return { ...base, hours, reason: "Conversation has no title or summary to match on." };
    }

    const result: MatchResult = matchTask(text, tasks);

    if (result.kind === "confident") {
      return {
        ...base,
        hours,
        status: "ready",
        confidence: "high",
        matched_task: view(result.task, result.score),
      };
    }

    // Ambiguous and no-match both land here: proposed, but never fileable in
    // bulk. The caller must resolve the task by hand.
    return {
      ...base,
      hours,
      status: "needs_review",
      confidence: result.kind === "ambiguous" ? "low" : "none",
      reason:
        result.kind === "ambiguous"
          ? "Several tasks match this conversation about equally well."
          : "No task resembles this conversation.",
      candidates: result.candidates.map((c2) => view(c2.task, c2.score)),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Rollup
 * ------------------------------------------------------------------ */

export interface SuggestedEntry {
  date: string;
  task_id: string;
  task_name: string;
  project_name: string;
  hours: number;
  notes: string;
  source_conversation_ids: string[];
}

/**
 * Merge the `ready` drafts into one proposed entry per task per day. Filing
 * six four-minute conversations as six separate Zoho entries is worse than
 * useless, so the shortcut path proposes the sum.
 *
 * Only high-confidence drafts are eligible. Anything needing review is
 * deliberately absent from this list — that is what keeps "file all" safe.
 */
export function rollUp(drafts: Draft[]): SuggestedEntry[] {
  const byKey = new Map<string, SuggestedEntry>();

  for (const d of drafts) {
    if (d.status !== "ready" || !d.matched_task || !d.date || !d.hours) continue;
    const key = `${d.date}::${d.matched_task.task_id}`;
    const existing = byKey.get(key);

    if (existing) {
      existing.hours = Number((existing.hours + d.hours).toFixed(2));
      existing.notes += `; ${d.conversation_summary}`;
      existing.source_conversation_ids.push(d.conversation_id);
    } else {
      byKey.set(key, {
        date: d.date,
        task_id: d.matched_task.task_id,
        task_name: d.matched_task.task_name,
        project_name: d.matched_task.project_name,
        hours: d.hours,
        notes: d.conversation_summary,
        source_conversation_ids: [d.conversation_id],
      });
    }
  }

  return [...byKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.task_name.localeCompare(b.task_name),
  );
}

/** Drafts grouped by calendar day, for a readable proposal. */
export function groupByDay(drafts: Draft[]): Array<{ date: string; drafts: Draft[] }> {
  const byDay = new Map<string, Draft[]>();
  for (const d of drafts) {
    const key = d.date ?? "unknown-date";
    const list = byDay.get(key);
    if (list) list.push(d);
    else byDay.set(key, [d]);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, list]) => ({ date, drafts: list }));
}
