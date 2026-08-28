import { describe, expect, it } from "vitest";
import {
  applyHarnessPatch,
  cloneStandardHarness,
  parseCustomHarnesses,
  resolveHarnessId,
  seedNodesFromDefinition,
  snapshotHarness,
  standardHarnessDefinition,
  STANDARD_HARNESS_ID,
  validateHarnessDraft,
} from "../lib/definitions";
import { MILESTONE_PIPELINE_ID } from "../lib/run-engine";
import { seedArcNodes, seedNodeId } from "../lib/harness";

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
});
