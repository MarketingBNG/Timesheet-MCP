import type { Task } from "./zoho.js";

/**
 * Task-name matching for log_time.
 *
 * The rule this module exists to enforce: never log against a guess. A match
 * is only "confident" when the best candidate scores highly AND is clearly
 * ahead of the runner-up. Two tasks at 0.91 and 0.90 is exactly the case where
 * a single threshold picks the wrong one.
 */

export const CONFIDENT_SCORE = 0.82;
export const MIN_GAP = 0.12;
export const CANDIDATE_FLOOR = 0.3;

/**
 * A moderate score can still be safe when nothing else comes close — an
 * abbreviated name ("payroll recon") scores middling against the full task
 * name but has no rival. Requires both a decent absolute score and a very
 * large gap, so it cannot rescue a genuine two-way tie.
 */
export const DOMINANT_SCORE = 0.55;
export const DOMINANT_GAP = 0.4;

export interface Scored {
  task: Task;
  score: number;
  reason: string;
}

export type MatchResult =
  | { kind: "confident"; task: Task; score: number; runnerUp?: Scored }
  | { kind: "ambiguous"; candidates: Scored[] }
  | { kind: "none"; candidates: Scored[] };

/** lowercase, strip punctuation, collapse whitespace. */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_/\\|]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "the", "a", "an", "for", "of", "on", "to", "and", "in", "with", "at", "by",
  "task", "work", "working",
]);

function tokens(s: string): string[] {
  return normalise(s)
    .split(" ")
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Levenshtein distance, iterative two-row form. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function levenshteinSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * Fraction of the query's tokens present in the candidate. Asymmetric on
 * purpose: "audit prep" should score well against "Q3 audit prep — ClientCo",
 * because people say the short form of a long task name.
 */
function tokenCoverage(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const candidateSet = new Set(candidateTokens);
  let hits = 0;
  for (const qt of queryTokens) {
    if (candidateSet.has(qt)) {
      hits += 1;
      continue;
    }
    // Near-miss on a single token (plural, typo) counts partially.
    const best = candidateTokens.reduce(
      (acc, ct) => Math.max(acc, levenshteinSimilarity(qt, ct)),
      0,
    );
    if (best >= 0.8) hits += best;
  }
  return hits / queryTokens.length;
}

export function scoreTask(query: string, task: Task): Scored {
  const q = normalise(query);
  const name = normalise(task.task_name);
  const qTokens = tokens(query);
  const nTokens = tokens(task.task_name);

  if (q.length === 0) return { task, score: 0, reason: "empty query" };

  if (q === name) return { task, score: 1, reason: "exact name match" };

  const coverage = tokenCoverage(qTokens, nTokens);
  const substring = name.includes(q) || q.includes(name) ? 1 : 0;
  const lev = levenshteinSimilarity(q, name);

  // Coverage dominates: it is the signal that survives long, decorated task
  // names. Substring is a strong confirmation. Raw edit distance is a weak
  // tiebreaker and is deliberately the smallest weight.
  let score = 0.55 * coverage + 0.3 * substring + 0.15 * lev;

  // A containing match against a much longer name is still good, but should
  // not beat an outright equal-length match.
  if (substring === 1 && name.length > q.length * 3) score -= 0.05;

  const reason =
    substring === 1
      ? "task name contains the phrase"
      : coverage >= 0.99
        ? "all words matched"
        : coverage > 0
          ? `${Math.round(coverage * 100)}% of words matched`
          : "weak similarity only";

  return { task, score: Math.max(0, Math.min(1, score)), reason };
}

export function matchTask(query: string, tasks: Task[], limit = 3): MatchResult {
  const scored = tasks
    .map((t) => scoreTask(query, t))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];

  if (!top || top.score < CANDIDATE_FLOOR) {
    return { kind: "none", candidates: scored.slice(0, limit).filter((s) => s.score > 0) };
  }

  const gap = top.score - (second?.score ?? 0);
  const strongAndClear = top.score >= CONFIDENT_SCORE && gap >= MIN_GAP;
  const dominant = top.score >= DOMINANT_SCORE && gap >= DOMINANT_GAP;

  if (strongAndClear || dominant) {
    return { kind: "confident", task: top.task, score: top.score, runnerUp: second };
  }

  return { kind: "ambiguous", candidates: scored.slice(0, limit) };
}
