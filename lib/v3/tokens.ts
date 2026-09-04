/**
 * v3 token accounting — never sums cumulative snapshots from the same thread.
 * Records one provider/model snapshot per role attempt and computes deltas
 * from captured start/end counters where available.
 */
import type { TokenCounters } from "../outcomes";

export type TokenSnapshot = TokenCounters & { at: number };

export function tokenDelta(start: TokenCounters | null, end: TokenCounters | null): TokenCounters {
  if (!start || !end) return { input: null, cached: null, output: null, reasoning: null, total: null };
  const diff = (a: number | null, b: number | null): number | null => {
    if (a == null || b == null) return null;
    const d = b - a;
    return d >= 0 ? d : null;
  };
  return {
    input: diff(start.input, end.input),
    cached: diff(start.cached, end.cached),
    output: diff(start.output, end.output),
    reasoning: diff(start.reasoning, end.reasoning),
    total: diff(start.total, end.total),
  };
}

/**
 * Aggregate across DISTINCT role threads only. Callers must pass one entry
 * per thread (latest snapshot per thread). This function refuses to double
 * count by thread id.
 */
export function sumDistinctThreadTokens(
  snapshots: Array<{ threadId: string; tokens: TokenCounters }>,
): TokenCounters {
  const seen = new Map<string, TokenCounters>();
  for (const s of snapshots) {
    if (!seen.has(s.threadId)) seen.set(s.threadId, s.tokens);
  }
  const add = (vals: Array<number | null>): number | null => {
    const nums = vals.filter((v): v is number => typeof v === "number");
    if (nums.length === 0) return null;
    return nums.reduce((a, b) => a + b, 0);
  };
  const list = [...seen.values()];
  return {
    input: add(list.map((t) => t.input)),
    cached: add(list.map((t) => t.cached)),
    output: add(list.map((t) => t.output)),
    reasoning: add(list.map((t) => t.reasoning)),
    total: add(list.map((t) => t.total)),
  };
}

export function formatTokens(total: number | null | undefined): string {
  if (total == null) return "unavailable";
  return String(total);
}
