import { describe, expect, it } from "vitest";
import {
  applyHarnessPatch,
  assertCustomCatalogFits,
  cloneStandardHarness,
  MAX_CUSTOM_HARNESSES,
  parseCustomHarnesses,
  parseHarnessDefinition,
  REMOVED_MILESTONE_PIPELINE_ID,
  resolveHarnessId,
  seedNodesFromDefinition,
  snapshotHarness,
  standardHarnessDefinition,
  STANDARD_HARNESS_ID,
  validateHarnessDraft,
} from "../lib/definitions";
import {
  namespacedNodeId,
  parseExecutionChoice,
  resolveDependencyIds,
  resolveNodeRef,
  seedArcNodes,
  seedNodeId,
} from "../lib/harness";
import { DEFAULT_PHASE_SPECS } from "../lib/harness";
import { canRework, parseTokenUsageEvent } from "../lib/outcomes";

describe("harness definitions", () => {
  it("defaults start selection to Standard Harness", () => {
    expect(resolveHarnessId({})).toBe(STANDARD_HARNESS_ID);
    expect(resolveHarnessId({ templateId: REMOVED_MILESTONE_PIPELINE_ID })).toBe(
      REMOVED_MILESTONE_PIPELINE_ID,
    );
    expect(resolveHarnessId({ harnessId: "milestone" })).toBe(REMOVED_MILESTONE_PIPELINE_ID);
    expect(resolveHarnessId({ harnessId: "c-mine-abcd1234" })).toBe("c-mine-abcd1234");
  });

  it("parses v1 custom definitions with Standard v2 defaults", () => {
    const parsed = parseHarnessDefinition({
      id: "c-old-aaaa1111",
      name: "Old custom",
      description: "from v1",
      kind: "custom",
      engine: "manual",
      phases: {
        explore: { title: "Look", detail: "Read." },
        plan: { title: "Write", detail: "DAG." },
        worker: { title: "Do", detail: "Ship." },
        critic: { title: "Check", detail: "Push back." },
        promote: { title: "Tell", detail: "Talk." },
      },
      createdAt: 1,
      updatedAt: 1,
    });
    expect(parsed?.schemaVersion).toBe(2);
    expect(parsed?.artifactPolicy).toBe("advisory");
    expect(parsed?.promoteMode).toBe("always");
    expect(parsed?.maxCorrections).toBeNull();
    expect(parsed?.phases.explore.execution).toBe("parent");
    expect(parsed?.phases.worker.execution).toBe("child");
    expect(parsed?.phases.worker.skills).toEqual([]);
  });

  it("rejects Milestone definitions instead of mapping them to Standard", () => {
    expect(
      parseHarnessDefinition({
        ...standardHarnessDefinition(),
        id: REMOVED_MILESTONE_PIPELINE_ID,
        kind: "builtin",
        engine: "milestone",
      }),
    ).toBeNull();
  });

  it("seeds unique per-plan node ids and skipped Promote when promoteMode is off", () => {
    const first = seedArcNodes("plan_a");
    const second = seedArcNodes("plan_b");
    expect(first.map((node) => node.id)).toEqual(
      ["explore", "plan", "worker", "critic", "promote"].map((phase) =>
        seedNodeId("plan_a", phase as "explore"),
      ),
    );
    expect(first.some((node) => second.some((other) => other.id === node.id))).toBe(false);
    const custom = cloneStandardHarness(
      { name: "No promote", promoteMode: "off" },
      () => "aaaaaaaa",
    );
    const seeded = seedNodesFromDefinition("p1", custom);
    expect(seeded.find((node) => node.phase === "promote")?.status).toBe("skipped");
  });

  it("snapshots custom v2 policies so later edits cannot mutate the copy", () => {
    const created = cloneStandardHarness(
      {
        name: "Careful ship",
        description: "Extra critic.",
        phases: {
          critic: { detail: "Be meaner.", execution: "child", skills: ["review"] },
        },
        maxCorrections: 2,
        artifactPolicy: "required",
      },
      () => "aaaaaaaa-bbbb-cccc",
      10,
    );
    expect(created.kind).toBe("custom");
    expect(created.engine).toBe("manual");
    expect(created.phases.critic.detail).toBe("Be meaner.");
    expect(created.phases.critic.skills).toEqual(["review"]);
    expect(created.maxCorrections).toBe(2);
    const frozen = snapshotHarness(created);
    const patched = applyHarnessPatch(
      created,
      { name: created.name, phases: { critic: { detail: "Be nicer." } }, maxCorrections: 9 },
      20,
    );
    expect(frozen.phases.critic.detail).toBe("Be meaner.");
    expect(frozen.maxCorrections).toBe(2);
    expect(patched.phases.critic.detail).toBe("Be nicer.");
    expect(patched.maxCorrections).toBe(9);
  });

  it("rejects reserved ids and builtin mutation", () => {
    expect(validateHarnessDraft({ name: "X", id: STANDARD_HARNESS_ID })).toMatch(/reserved/i);
    expect(validateHarnessDraft({ name: "X", id: REMOVED_MILESTONE_PIPELINE_ID })).toMatch(
      /reserved/i,
    );
    expect(() => applyHarnessPatch(standardHarnessDefinition(), { name: "Nope" })).toThrow(
      /immutable/i,
    );
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
    expect(created.phases.critic.title).toBe(DEFAULT_PHASE_SPECS.critic.title);
    expect(created.phases.critic.detail).toBe(DEFAULT_PHASE_SPECS.critic.detail);
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
    expect(() => resolveDependencyIds(nodes, ["nope"], "planx")).toThrow(/unknown dependency/i);
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

  it("parses token usage events and leaves missing counters null", () => {
    expect(
      parseTokenUsageEvent({
        type: "thread/tokenUsage/updated",
        tokenUsage: {
          total: {
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 4,
            reasoningOutputTokens: 1,
            totalTokens: 17,
          },
        },
      }),
    ).toEqual({ input: 10, cached: 2, output: 4, reasoning: 1, total: 17 });
    expect(parseTokenUsageEvent({ type: "thread/tokenUsage/updated" })).toBeNull();
    expect(canRework(1, 1)).toBe(false);
    expect(canRework(1, null)).toBe(true);
  });
});
