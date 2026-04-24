// ============================================================
//  MISE — Date Range Utilities
// ============================================================

import type { ReportPeriod, GroupBy } from "../types/reporting.types";

export interface DateRange {
  from:     Date;
  to:       Date;
  prevFrom: Date;  // same length period before — for % comparisons
  prevTo:   Date;
}

// ── Resolve period to concrete dates ──────────────────────────

export function resolveDateRange(
  period: ReportPeriod = "today",
  dateFrom?: string,
  dateTo?: string,
  tz = "Europe/Istanbul"
): DateRange {
  const now   = new Date();
  const today = startOfDay(now);

  let from: Date;
  let to:   Date;

  switch (period) {
    case "today":
      from = today;
      to   = endOfDay(today);
      break;

    case "yesterday":
      from = startOfDay(addDays(today, -1));
      to   = endOfDay(addDays(today, -1));
      break;

    case "week":
      from = startOfDay(addDays(today, -6));   // last 7 days incl. today
      to   = endOfDay(today);
      break;

    case "month":
      from = startOfDay(addDays(today, -29));  // last 30 days
      to   = endOfDay(today);
      break;

    case "quarter":
      from = startOfDay(addDays(today, -89));  // last 90 days
      to   = endOfDay(today);
      break;

    case "year":
      from = startOfDay(addDays(today, -364)); // last 365 days
      to   = endOfDay(today);
      break;

    case "custom":
      if (!dateFrom || !dateTo) {
        throw new Error("dateFrom and dateTo are required for custom period");
      }
      from = startOfDay(new Date(dateFrom));
      to   = endOfDay(new Date(dateTo));
      break;

    default:
      from = today;
      to   = endOfDay(today);
  }

  // Previous period — same duration, immediately before
  const duration = to.getTime() - from.getTime();
  const prevTo   = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - duration);

  return { from, to, prevFrom, prevTo };
}

// ── Suggest groupBy based on range length ─────────────────────

export function suggestGroupBy(from: Date, to: Date): GroupBy {
  const days = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 1)   return "hour";
  if (days <= 31)  return "day";
  if (days <= 120) return "week";
  return "month";
}

// ── Generate time buckets for timeline ───────────────────────

export function generateTimeBuckets(
  from: Date,
  to: Date,
  groupBy: GroupBy
): string[] {
  const buckets: string[] = [];
  const cursor = new Date(from);

  while (cursor <= to) {
    switch (groupBy) {
      case "hour":
        buckets.push(cursor.toISOString().slice(0, 13) + ":00");
        cursor.setHours(cursor.getHours() + 1);
        break;
      case "day":
        buckets.push(cursor.toISOString().slice(0, 10));
        cursor.setDate(cursor.getDate() + 1);
        break;
      case "week":
        buckets.push(`W${isoWeek(cursor)}-${cursor.getFullYear()}`);
        cursor.setDate(cursor.getDate() + 7);
        break;
      case "month":
        buckets.push(cursor.toISOString().slice(0, 7));
        cursor.setMonth(cursor.getMonth() + 1);
        break;
    }
  }

  return buckets;
}

// ── Format a date into a bucket key ──────────────────────────

export function dateToBucket(date: Date, groupBy: GroupBy): string {
  switch (groupBy) {
    case "hour":  return date.toISOString().slice(0, 13) + ":00";
    case "day":   return date.toISOString().slice(0, 10);
    case "week":  return `W${isoWeek(date)}-${date.getFullYear()}`;
    case "month": return date.toISOString().slice(0, 7);
  }
}

// ── Percent change helper ─────────────────────────────────────

export function pctChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return parseFloat(((current - previous) / previous * 100).toFixed(1));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Date helpers ──────────────────────────────────────────────

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}
