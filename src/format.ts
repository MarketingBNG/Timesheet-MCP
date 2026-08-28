import { ZohoError } from "./errors.js";

/** Decimal hours (2.5) -> Zoho's "HH:MM" timelog format ("02:30"). */
export function hoursToHHMM(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new ZohoError(`Hours must be a positive number, got ${hours}.`);
  }
  // Round to the nearest minute; Zoho stores minute granularity.
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes === 0) {
    throw new ZohoError("Hours rounds to zero minutes — nothing to log.");
  }
  if (totalMinutes > 24 * 60) {
    throw new ZohoError(`Cannot log ${hours} hours against a single day.`);
  }
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "02:30" -> 2.5, for summing what Zoho hands back. */
export function hhmmToHours(hhmm: string): number {
  const m = /^(\d{1,3}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return 0;
  return Number(m[1]) + Number(m[2]) / 60;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertIsoDate(date: string, field = "date"): string {
  if (!ISO_DATE.test(date)) {
    throw new ZohoError(`${field} must be in YYYY-MM-DD format, got "${date}".`);
  }
  const [, y, mo, d] = ISO_DATE.exec(date)!;
  const parsed = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== Number(d)) {
    throw new ZohoError(`${field} "${date}" is not a real calendar date.`);
  }
  return date;
}

/**
 * Render an ISO date in the portal's own date format. Zoho rejects dates that
 * do not match the portal setting (e.g. an Indian portal on dd-MM-yyyy will
 * silently misread 03-04-2026), so we always convert rather than assume.
 */
export function toPortalDate(isoDate: string, portalFormat: string): string {
  assertIsoDate(isoDate);
  const [year, month, day] = isoDate.split("-");
  return portalFormat
    .replace(/yyyy/gi, year)
    .replace(/MM/g, month)
    .replace(/dd/g, day);
}

/** Parse a portal-formatted date back to ISO, for grouping results by day. */
export function fromPortalDate(value: string, portalFormat: string): string | null {
  const tokens: Array<{ token: string; index: number }> = [];
  for (const token of ["yyyy", "MM", "dd"]) {
    const index = portalFormat.toLowerCase().indexOf(token.toLowerCase());
    if (index === -1) return null;
    tokens.push({ token, index });
  }
  tokens.sort((a, b) => a.index - b.index);

  const parts = value.trim().split(/[^0-9]+/).filter(Boolean);
  if (parts.length < 3) return null;

  const out: Record<string, string> = {};
  tokens.forEach((t, i) => {
    out[t.token] = parts[i];
  });
  if (!out.yyyy || !out.MM || !out.dd) return null;
  return `${out.yyyy.padStart(4, "0")}-${out.MM.padStart(2, "0")}-${out.dd.padStart(2, "0")}`;
}

/** Inclusive list of ISO dates between two ISO dates. */
export function dateRange(fromIso: string, toIso: string, maxDays = 186): string[] {
  assertIsoDate(fromIso, "date_from");
  assertIsoDate(toIso, "date_to");
  const start = Date.parse(`${fromIso}T00:00:00Z`);
  const end = Date.parse(`${toIso}T00:00:00Z`);
  if (end < start) {
    throw new ZohoError(`date_to (${toIso}) is before date_from (${fromIso}).`);
  }
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (days > maxDays) {
    throw new ZohoError(`Date range spans ${days} days; the maximum is ${maxDays}.`);
  }
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    out.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}
