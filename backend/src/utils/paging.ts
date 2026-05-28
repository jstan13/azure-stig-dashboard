/**
 * Pagination helpers.
 *
 * Query-string values arrive as strings (or arrays) and may be missing,
 * non-numeric, negative, or absurdly large. `Number('abc')` yields NaN, which
 * silently breaks `slice()`/`skip`/`take` math. These helpers coerce input to
 * safe, bounded integers so route handlers never operate on NaN.
 */

/** Parse a 1-based page number. Falls back to 1 for invalid/missing input. */
export function parsePage(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Parse a page size, clamped to [1, max]. Falls back to `def` for
 * invalid/missing input.
 */
export function parsePageSize(value: unknown, def = 20, max = 100): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

/**
 * Parse a "days" lookback window, clamped to [1, max]. Falls back to `def` for
 * invalid/missing input.
 */
export function parseDays(value: unknown, def = 30, max = 365): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}
