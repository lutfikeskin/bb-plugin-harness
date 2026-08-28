import { describe, expect, it } from "vitest";
import {
  applyHarnessPatch,
  assertCustomCatalogFits,
  cloneStandardHarness,
  MAX_CUSTOM_HARNESSES,
  parseCustomHarnesses,
  parseHarnessDefinition,
  resolveHarnessId,
  seedNodesFromDefinition,
  snapshotHarness,
  standardHarnessDefinition,
  STANDARD_HARNESS_ID,
  validateHarnessDraft,
} from "../lib/definitions";
import { MILESTONE_PIPELINE_ID } from "../lib/run-engine";
import {
  namespacedNodeId,
  parseExecutionChoice,
  resolveDependencyIds,
  resolveNodeRef,
  seedArcNodes,
  seedNodeId,
} from "../lib/harness";
import { DEFAULT_PHASE_SPECS } from "../lib/harness";

describe("harness definitions", () => {
  it("defaults start selection to Standard Harness, not Milestone", () => {
    expect(resolveHarnessId({})).toBe(STANDARD_HARNESS_ID);
    expect(resolveHarnessId({ templateId: MILESTONE_PIPELINE_ID })).toBe(
      MILESTONE_PIPELINE_ID,
    );
    expect(resolveHarnessId({ harnessId: "c-mine-abcd1234" })).toBe(
      "c-mine-abcd1234",
    );
  });

  it("seeds unique per-plan node ids", () => {
    const first = seedArcNodes("plan_a");
    const second = seedArcNodes("plan_b");
    expect(first.map((node) => node.id)).toEqual(
      ["explore", "plan", "worker", "critic", "promote"].map((phase) =>
        seedNodeId("plan_a", phase as "explore"),
      ),
    );
    expect(first.some((node) => second.some((other) => other.id === node.id))).toBe(
      false,
    );
    expect(first[2]?.deps).toEqual([seedNodeId("plan_a", "plan")]);
  });

  it("snapshots custom instructions so later edits cannot mutate the copy", () => {
    const created = cloneStandardHarness(
      {
        name: "Careful ship",
        description: "Extra critic.",
        phases: { critic: { detail: "Be meaner." } },
      },
      () => "aaaaaaaa-bbbb-cccc",
      10,
    );
    expect(created.kind).toBe("custom");
    expect(created.engine).toBe("manual");
    expect(created.phases.critic.detail).toBe("Be meaner.");
    const frozen = snapshotHarness(created);
    const patched = applyHarnessPatch(
      created,
      { name: created.name, phases: { critic: { detail: "Be nicer." } } },
      20,
    );
    expect(frozen.phases.critic.detail).toBe("Be meaner.");
    expect(patched.phases.critic.detail).toBe("Be nicer.");
    expect(seedNodesFromDefinition("p1", frozen)[3]?.detail).toBe("Be meaner.");
  });

  it("rejects reserved ids and builtin mutation", () => {
    expect(validateHarnessDraft({ name: "X", id: STANDARD_HARNESS_ID })).toMatch(
      /reserved/i,
    );
    expect(() =>
      applyHarnessPatch(standardHarnessDefinition(), { name: "Nope" }),
    ).toThrow(/immutable/i);
    expect(
      parseCustomHarnesses([
        { ...standardHarnessDefinition(), kind: "custom" },
        cloneStandardHarness({ name: "Ok" }, () => "11111111"),
      ]).map((item) => item.name),
    ).toEqual(["Ok"]);
  });

  it("treats empty phase instructions as Standard copy", () => {
    const created = cloneStandardHarness(
      { name: "Blank critic", phases: { critic: { title: "  ", detail: "" } } },
      () => "22222222",
    );
    expect(created.phases.critic).toEqual(DEFAULT_PHASE_SPECS.critic);
    const parsed = parseHarnessDefinition({
      ...created,
      phases: {
        ...created.phases,
        worker: { title: "", detail: "" },
      },
    });
    expect(parsed?.phases.worker).toEqual(DEFAULT_PHASE_SPECS.worker);
  });

  it("enforces a custom catalog ceiling", () => {
    const item = cloneStandardHarness({ name: "One" }, () => "33333333");
    const tooMany = Array.from({ length: MAX_CUSTOM_HARNESSES + 1 }, (_, index) => ({
      ...item,
      id: `c-too-${index}`,
    }));
    expect(() => assertCustomCatalogFits(tooMany)).toThrow(/at most/i);
  });

  it("resolves phase aliases after exact ids and namespaces generated ids", () => {
    const nodes = seedArcNodes("planx").map((node, sortOrder) => ({
      ...node,
      status: "pending" as const,
      sortOrder,
    }));
    expect(resolveNodeRef(nodes, `${"planx"}-worker`, "planx")).toBe("planx-worker");
    expect(resolveNodeRef(nodes, "worker", "planx")).toBe("planx-worker");
    expect(resolveDependencyIds(nodes, ["explore", "plan"], "planx")).toEqual([
      "planx-explore",
      "planx-plan",
    ]);
    expect(() => resolveDependencyIds(nodes, ["nope"], "planx")).toThrow(
      /unknown dependency/i,
    );
    const taken = new Set(nodes.map((node) => node.id));
    const generated = namespacedNodeId("planx", "Extra worker", taken, () => "z");
    expect(generated.startsWith("planx-")).toBe(true);
    expect(taken.has(generated)).toBe(false);
  });

  it("trims routing provider and model and rejects blanks", () => {
    expect(
      parseExecutionChoice({
        providerId: "  pi  ",
        model: "  opus  ",
        reasoningLevel: "high",
      }),
    ).toEqual({ providerId: "pi", model: "opus", reasoningLevel: "high" });
    expect(
      parseExecutionChoice({
        providerId: "   ",
        model: "opus",
        reasoningLevel: "high",
      }),
    ).toBeNull();
  });
});
