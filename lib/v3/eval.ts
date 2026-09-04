/** v3 run evaluation — compact, local-only. */
import type { V3RunEvaluation } from "./types";

export function emptyEvaluation(): V3RunEvaluation {
  return { outcome: null, reworkCount: 0, acceptedAttempts: 0, failedAttempts: 0, elapsedMs: null, note: null };
}

export function summarizeEvaluation(evalData: V3RunEvaluation): string {
  const outcome = evalData.outcome ?? "unrated";
  const elapsed = evalData.elapsedMs == null ? "—" : `${Math.round(evalData.elapsedMs / 1000)}s`;
  return `outcome ${outcome} · rework ${evalData.reworkCount} · accepted ${evalData.acceptedAttempts} · failed ${evalData.failedAttempts} · elapsed ${elapsed}${evalData.note ? ` · ${evalData.note}` : ""}`;
}
