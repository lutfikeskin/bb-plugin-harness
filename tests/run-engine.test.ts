import { describe, expect, it } from "vitest";
import {
  canApproveCorrection,
  canApprovePlan,
  firstReadyNode,
  intentAfterPacket,
  milestonePipelineNodes,
  validateRolePacket,
  type HarnessRun,
  type HarnessRunNode,
} from "../lib/run-engine";

function node(
  key: string,
  status: HarnessRunNode["status"],
  deps: string[],
  extra: Partial<HarnessRunNode> = {},
): HarnessRunNode {
  const role =
    key.startsWith("reviewer")
      ? "reviewer"
      : key.startsWith("worker")
        ? "worker"
        : (key as HarnessRunNode["role"]);
  return {
    id: key,
    runId: "run",
    templateNodeKey: key,
    role: role as HarnessRunNode["role"],
    phase: "worker",
    ordinal: 0,
    status,
    deps,
    childThreadId: null,
    providerId: null,
    model: null,
    reasoningLevel: null,
    serviceTier: null,
    startedAt: null,
    completedAt: null,
    packetVersion: 1,
    ...extra,
  };
}

function run(status: HarnessRun["status"], correctionCount = 0): HarnessRun {
  return {
    id: "run",
    projectId: "p",
    parentThreadId: "t",
    templateId: "milestone-pipeline",
    status,
    currentStageId: null,
    taskPacket: {
      objective: "do the thing",
      branch: null,
      execPlanPath: null,
      protectedPaths: [],
      runScout: true,
      specialistQuestion: null,
      routingOverrides: null,
      projectId: "p",
      parentThreadId: "t",
      environmentId: "env",
      promptVersion: "v",
      schemaVersion: "v",
    },
    correctionCount,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
  };
}

describe("milestone pipeline", () => {
  it("defaults to Scout as the first ready node", () => {
    const templates = milestonePipelineNodes({ runScout: true, specialistQuestion: null });
    expect(templates[0]?.key).toBe("scout");
    expect(templates.find((item) => item.key === "scout")?.skip).toBe(false);
    expect(templates.find((item) => item.key === "specialist")?.skip).toBe(true);
  });

  it("skips Scout when disabled so Planner is first required node", () => {
    const templates = milestonePipelineNodes({ runScout: false, specialistQuestion: null });
    expect(templates.find((item) => item.key === "scout")?.skip).toBe(true);
    expect(templates.find((item) => item.key === "planner")?.skip).toBe(false);
  });
});

describe("packet validation", () => {
  it("rejects role/kind mismatch", () => {
    const result = validateRolePacket("scout", "plan_packet", { summary: "x" });
    expect(result.ok).toBe(false);
  });

  it("requires correctionRequest for CORRECTION_REQUIRED", () => {
    const result = validateRolePacket("reviewer", "review_verdict", {
      verdict: "CORRECTION_REQUIRED",
      summary: "needs work",
    });
    expect(result.ok).toBe(false);
  });
});

describe("transitions", () => {
  it("holds after Planner until operator approval", () => {
    const nodes = [
      node("scout", "done", []),
      node("planner", "done", ["scout"]),
      node("worker", "pending", ["planner"]),
    ];
    const intent = intentAfterPacket({
      run: run("running"),
      nodes,
      completed: nodes[1]!,
      payload: { summary: "plan" },
    });
    expect(intent).toEqual({ type: "await_plan_approval" });
    expect(canApprovePlan(run("awaiting_plan_approval"))).toBe(true);
  });

  it("starts Reviewer after Worker", () => {
    const nodes = [
      node("planner", "done", []),
      node("worker", "done", ["planner"]),
      node("reviewer", "pending", ["worker"]),
    ];
    expect(firstReadyNode(nodes)?.templateNodeKey).toBe("reviewer");
    const intent = intentAfterPacket({
      run: run("running"),
      nodes,
      completed: nodes[1]!,
      payload: { summary: "work", changedPaths: [] },
    });
    expect(intent).toEqual({ type: "start_node", templateNodeKey: "reviewer" });
  });

  it("APPROVE starts Promote", () => {
    const nodes = [
      node("worker", "done", []),
      node("reviewer", "done", ["worker"]),
      node("promote", "pending", ["reviewer"]),
    ];
    const intent = intentAfterPacket({
      run: run("running"),
      nodes,
      completed: nodes[1]!,
      payload: { verdict: "APPROVE", summary: "ok" },
    });
    expect(intent).toEqual({ type: "start_node", templateNodeKey: "promote" });
  });

  it("BLOCKED terminates", () => {
    const intent = intentAfterPacket({
      run: run("running"),
      nodes: [node("reviewer", "done", [])],
      completed: node("reviewer", "done", []),
      payload: { verdict: "BLOCKED", summary: "no" },
    });
    expect(intent.type).toBe("blocked");
  });

  it("allows one correction then blocks a second loop", () => {
    const first = intentAfterPacket({
      run: run("running", 0),
      nodes: [node("reviewer", "done", [])],
      completed: node("reviewer", "done", []),
      payload: { verdict: "CORRECTION_REQUIRED", summary: "fix", correctionRequest: "fix tests" },
    });
    expect(first).toEqual({ type: "await_correction_approval" });
    expect(canApproveCorrection(run("awaiting_correction_approval", 0))).toBe(true);
    expect(canApproveCorrection(run("awaiting_correction_approval", 1))).toBe(false);

    const final = intentAfterPacket({
      run: run("running", 1),
      nodes: [node("reviewer_final", "done", [], { role: "reviewer" })],
      completed: node("reviewer_final", "done", [], { role: "reviewer" }),
      payload: { verdict: "CORRECTION_REQUIRED", summary: "again", correctionRequest: "more" },
    });
    expect(final.type).toBe("blocked");
  });
});
