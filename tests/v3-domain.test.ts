import { describe, expect, it } from "vitest";
import {
  allRequiredDone,
  downstreamV3,
  readyV3Nodes,
  validateV3Draft,
  wouldCycleV3,
} from "../lib/v3/dag";
import { assertTransitionV3, canTransitionV3 } from "../lib/v3/state";
import { buildTaskPacket, packetBytes, slicePacketForRole } from "../lib/v3/packets";
import {
  validateCriticReport,
  validateExplorationReport,
  validateWorkerReport,
} from "../lib/v3/reports";
import {
  inheritPreset,
  migrateLegacyRouting,
  resolveNodeRouting,
  validatePreset,
} from "../lib/v3/presets";
import { isSafeV3ArtifactRef, parseV3ArtifactPaths } from "../lib/v3/artifacts";
import { sumDistinctThreadTokens, tokenDelta } from "../lib/v3/tokens";

describe("v3 DAG", () => {
  it("rejects empty drafts, legacy phase nodes, and unknown deps", () => {
    expect(validateV3Draft([]).ok).toBe(false);
    expect(validateV3Draft([{ title: "t", objective: "o", acceptanceCriteria: [] }]).ok).toBe(false);
    const legacy = validateV3Draft([
      { title: "t", objective: "o", acceptanceCriteria: ["a"], phase: "critic" },
    ]);
    expect(legacy.ok).toBe(false);
    const nodes = [
      { id: "a", dependencies: [] as string[] },
      { id: "b", dependencies: ["a"] },
    ];
    expect(wouldCycleV3(nodes)).toBe(false);
    expect(wouldCycleV3([{ id: "a", dependencies: ["b"] }, { id: "b", dependencies: ["a"] }])).toBe(true);
  });

  it("computes readiness topologically and downstream invalidation", () => {
    const nodes = [
      { id: "a", status: "done", dependencies: [] as string[] },
      { id: "b", status: "pending", dependencies: ["a"] },
      { id: "c", status: "pending", dependencies: ["b"] },
    ];
    expect(readyV3Nodes(nodes).map((n) => n.id)).toEqual(["b"]);
    expect(downstreamV3(nodes, ["b"])).toEqual(new Set(["b", "c"]));
    expect(allRequiredDone(nodes)).toBe(false);
    expect(allRequiredDone([{ status: "done" }, { status: "skipped" }])).toBe(true);
  });

  it("rejects oversized packets by shedding bulk, never crashing", () => {
    const big = "x".repeat(50_000);
    const packet = buildTaskPacket({
      runId: "r1",
      packetVersion: 1,
      objective: big,
      project: { id: "p", name: "p", environmentId: "e", workspacePath: "/tmp" },
      constraints: [],
      exploration: null,
      approvedPlan: null,
      currentNode: null,
      dependencyResults: [],
      decisions: [],
      artifactIndex: [],
      verificationSummary: [],
    });
    expect(packetBytes(packet)).toBeLessThanOrEqual(24_000 + 8_000);
    expect(packet.objective.length).toBeLessThan(big.length);
  });

  it("slices packets per role without leaking", () => {
    const packet = buildTaskPacket({
      runId: "r1",
      packetVersion: 1,
      objective: "ship",
      project: { id: "p", name: "p", environmentId: "e", workspacePath: "/tmp" },
      constraints: ["c"],
      exploration: { summary: "s", findings: [], suggestedNodes: [], risks: [], artifactRefs: [], createdAt: 0 },
      approvedPlan: null,
      currentNode: null,
      dependencyResults: [],
      decisions: [],
      artifactIndex: [],
      verificationSummary: [],
    });
    const explorer = slicePacketForRole(packet, "explorer") as Record<string, unknown>;
    expect(explorer.objective).toBe("ship");
    expect("approvedPlan" in explorer).toBe(false);
    const planner = slicePacketForRole(packet, "planner") as Record<string, unknown>;
    expect("exploration" in planner).toBe(true);
  });
});

describe("v3 state machine", () => {
  it("allows the happy path and rejects skips", () => {
    expect(canTransitionV3("Setup", "Exploring")).toBe(true);
    expect(canTransitionV3("Setup", "Executing")).toBe(false);
    expect(() => assertTransitionV3("Executing", "Complete")).toThrow();
    // Critic cannot start early is enforced server-side; states reflect it.
    expect(canTransitionV3("Critiquing", "FinalReview")).toBe(true);
  });
});

describe("v3 reports", () => {
  it("validates worker/critic/exploration schemas", () => {
    expect(validateWorkerReport({ outcome: "complete" }).ok).toBe(false);
    expect(
      validateWorkerReport({ outcome: "complete", summary: "did it", changedFiles: [], artifactRefs: [], risks: [] }).ok,
    ).toBe(true);
    expect(validateCriticReport({ recommendation: "REWORK" }).ok).toBe(false);
    expect(
      validateCriticReport({ recommendation: "REWORK", affectedNodeIds: ["a"], findings: [], unsupportedClaims: [], risks: [] }).ok,
    ).toBe(true);
    expect(validateExplorationReport({ summary: "" }).ok).toBe(false);
  });
});

describe("v3 presets", () => {
  it("defaults to inherit and migrates legacy routing", () => {
    const preset = inheritPreset();
    expect(Object.values(preset.roles).every((r) => r.choice === null)).toBe(true);
    const migrated = migrateLegacyRouting({
      explore: { providerId: "acp-devin", model: "m", reasoningLevel: "medium" },
      plan: null,
      workerFirst: null,
      workerRest: null,
      critic: null,
      promote: null,
    });
    expect(migrated.id).toBe("migrated-role-routing");
    expect(migrated.roles.explorer.choice?.providerId).toBe("acp-devin");
    const bad = validatePreset({ ...migrated, roles: { ...migrated.roles, critic: { choice: { providerId: "", model: "", reasoningLevel: "" }, permissionMode: "root", skillHints: [] } } });
    expect(bad.ok).toBe(false);
  });

  it("resolves node overrides over preset with source labels", () => {
    const preset = inheritPreset();
    preset.roles.workerFirst.choice = { providerId: "pi", model: "m", reasoningLevel: "high" };
    const node = {
      id: "a", title: "a", objective: "o", dependencies: [], acceptanceCriteria: ["c"],
      verificationCommands: [], expectedArtifacts: [], skillHints: [], status: "pending" as const,
      planRevision: 1, attemptId: null, routingOverride: null,
    };
    const resolved = resolveNodeRouting({ preset, nodes: [node], node, workerIndex: 0 });
    expect(resolved.source).toBe("preset");
    const overridden = resolveNodeRouting({
      preset, nodes: [node],
      node: { ...node, routingOverride: { providerId: "x", model: "y", reasoningLevel: "high" } },
      workerIndex: 0,
    });
    expect(overridden.source).toBe("node override");
  });
});

describe("v3 artifacts", () => {
  it("rejects traversal, absolute paths, URLs, and control chars", () => {
    expect(isSafeV3ArtifactRef("artifacts/harness/r/note.md")).toBe(true);
    expect(isSafeV3ArtifactRef("../secret.md")).toBe(false);
    expect(isSafeV3ArtifactRef("/abs.md")).toBe(false);
    expect(isSafeV3ArtifactRef("https://x/y")).toBe(false);
    expect(isSafeV3ArtifactRef("artifacts/a\u0000b")).toBe(false);
    expect(parseV3ArtifactPaths(["artifacts/a.md", "../b"])).toBeNull();
  });
});

describe("v3 tokens", () => {
  it("deltas only with both endpoints and sums distinct threads once", () => {
    expect(tokenDelta(null, { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 }).total).toBeNull();
    expect(tokenDelta(
      { input: 10, cached: 0, output: 5, reasoning: 0, total: 15 },
      { input: 15, cached: 1, output: 7, reasoning: 0, total: 23 },
    )).toMatchObject({ input: 5, total: 8 });
    const summed = sumDistinctThreadTokens([
      { threadId: "t1", tokens: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 } },
      { threadId: "t1", tokens: { input: 100, cached: 0, output: 100, reasoning: 0, total: 200 } },
      { threadId: "t2", tokens: { input: 3, cached: 0, output: 1, reasoning: 0, total: 4 } },
    ]);
    // Same thread counted once (first snapshot wins for distinct-thread sums).
    expect(summed.total).toBe(6);
  });
});
