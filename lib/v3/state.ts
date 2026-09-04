/**
 * v3 run state machine. Pure — no BB SDK.
 */
import type { V3RunState } from "./types";

const TRANSITIONS: Record<V3RunState, readonly V3RunState[]> = {
  Setup: ["Exploring", "Cancelled"],
  Exploring: ["Planning", "Blocked", "Cancelled"],
  Planning: ["PlanApproval", "Blocked", "Cancelled"],
  PlanApproval: ["Planning", "Executing", "Cancelled"],
  Executing: ["WorkerReview", "Critiquing", "Blocked", "Cancelled"],
  WorkerReview: ["Executing", "Planning", "Critiquing", "Cancelled"],
  Critiquing: ["FinalReview", "Blocked", "Cancelled"],
  FinalReview: ["Executing", "Blocked", "Promoting", "Complete", "Cancelled"],
  Promoting: ["Complete", "Blocked", "Cancelled"],
  Blocked: ["Planning", "Executing", "Cancelled"],
  Complete: [],
  Cancelled: [],
};

export function canTransitionV3(from: V3RunState, to: V3RunState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransitionV3(from: V3RunState, to: V3RunState): void {
  if (!canTransitionV3(from, to)) {
    throw new Error(`Invalid Harness transition ${from} → ${to}.`);
  }
}

export function v3Transitions(): Record<V3RunState, readonly V3RunState[]> {
  return TRANSITIONS;
}

/** Human-readable primary copy per state. Never exposes rev/mutation/attempt internals. */
export function v3StateCopy(state: V3RunState): { title: string; body: string; primary: string } {
  switch (state) {
    case "Setup":
      return { title: "Setup", body: "Describe the task and confirm routing. Nothing has started yet.", primary: "Start Harness" };
    case "Exploring":
      return { title: "Exploring", body: "Explorer is investigating the workspace and constraints.", primary: "View Explorer" };
    case "Planning":
      return { title: "Planning", body: "Planner is turning exploration into an explicit task DAG.", primary: "View Planner" };
    case "PlanApproval":
      return { title: "Plan approval", body: "Planner proposed implementation tasks. Review dependencies and acceptance criteria.", primary: "Approve plan" };
    case "Executing":
      return { title: "Building", body: "Workers are implementing approved tasks in dependency order.", primary: "Run next task" };
    case "WorkerReview":
      return { title: "Worker review", body: "A Worker finished. Review its report, then accept or request changes.", primary: "Review worker report" };
    case "Critiquing":
      return { title: "Review", body: "Critic is independently reviewing the objective, plan, reports, and checks.", primary: "View Critic" };
    case "FinalReview":
      return { title: "Final review", body: "Critic reported. You decide: approve, bounded rework, or block.", primary: "Decide" };
    case "Promoting":
      return { title: "Share", body: "Promoter is preparing communication for the verified result.", primary: "View Promoter" };
    case "Blocked":
      return { title: "Blocked", body: "The run is blocked with a reason and a recovery action.", primary: "Recover" };
    case "Complete":
      return { title: "Done", body: "Result verified. Review checks, artifacts, and provider usage.", primary: "View summary" };
    case "Cancelled":
      return { title: "Cancelled", body: "The run was cancelled after stopping active role threads.", primary: "Start over" };
    default:
      return { title: String(state), body: "", primary: "View run" };
  }
}
