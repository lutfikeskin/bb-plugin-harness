import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { submitPlanDraftFromTool } from "../lib/v3-backend";
import { canTransitionV3 } from "../lib/v3/state";

const PROJECT = "proj_v3fix";
const HOME = "thr_home_fix";
const HOME2 = "thr_home_fix2";
const ENV = "env_fix";

const STRICT_MODELS = [
  { model: "swe-1-7-medium", routeProviderId: "acp-devin", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "m" }] },
  { model: "openai-codex/gpt-5.6-sol", routeProviderId: "pi", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "h" }] },
  { model: "opencode/muse-spark-1.3-contributor-free", routeProviderId: "pi", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "h" }] },
  { model: "grok-4.6", routeProviderId: "acp-cursor", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "h" }] },
  { model: "model-first", routeProviderId: "opencode", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "h" }, { reasoningEffort: "medium", description: "m" }] },
  { model: "model-rest", routeProviderId: "acp-devin", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "m" }] },
  { model: "model-override", routeProviderId: "opencode", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "h" }] },
  { model: "model-critic", routeProviderId: "openai-codex", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "h" }] },
  { model: "opencode/muse-spark-1.3-contributor-free", routeProviderId: "opencode", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "h" }, { reasoningEffort: "medium", description: "m" }] },
];

async function loadFix(options?: { providers?: Array<{ id: string }>; models?: Array<Record<string, unknown>> }) {
  let childSeq = 0;
  const threads = new Map([
    [HOME, makeThreadResponse({ id: HOME, projectId: PROJECT, environmentId: ENV, providerId: "pi" })],
    [HOME2, makeThreadResponse({ id: HOME2, projectId: PROJECT, environmentId: ENV, providerId: "pi" })],
  ]);
  const host = createFakePluginHost({
    pluginId: "harness",
    agentSkillIds: ["harness-arc", "harness-planner", "harness-worker", "harness-critic", "harness-promoter"],
    sdk: {
      environments: {
        get: async () => ({ id: ENV, hostId: "host_1", path: "/tmp/ws" }),
      },
      files: {
        mkdir: async () => ({ path: "/tmp/ws/artifacts" }),
        read: async () => {
          throw new Error("missing");
        },
        write: async () => ({ outcome: "written", sha256: "abc", sizeBytes: 10 }),
      },
      providers: {
        models: async () => ({
          providers: options?.providers ?? [
            { id: "pi", available: true },
            { id: "acp-devin", available: true },
            { id: "acp-cursor", available: true },
          ],
          models: options?.models ?? STRICT_MODELS,
        }),
        list: async () => options?.providers ?? [{ id: "pi" }, { id: "acp-devin" }, { id: "acp-cursor" }],
      },
      skills: {
        list: async () => ({ skills: [] }),
      },
      projects: {
        get: async () => ({ id: PROJECT, name: "fixproj" }),
        commands: async () => ({ commands: [] }),
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const t = threads.get(threadId);
          if (!t) throw new Error(`missing thread ${threadId}`);
          return t;
        },
        output: async () => ({ output: "output" }),
        send: async () => ({ ok: true, delivery: "sent" as const }),
        spawn: async (args: Record<string, unknown>) => {
          childSeq += 1;
          const child = makeThreadResponse({
            id: `thr_fix_${childSeq}`,
            projectId: PROJECT,
            environmentId: ENV,
            parentThreadId: String(args.parentThreadId),
          });
          threads.set(child.id, child);
          return child;
        },
        stop: async ({ threadId }: { threadId: string }) => threads.get(threadId),
        events: { list: async () => [] },
      },
    },
  });
  await plugin(host.bb);
  return { host, threads };
}

type Status = {
  run: {
    id: string;
    revision: number;
    state: string;
    plannerThreadId: string;
    explorerThreadId: string | null;
    criticThreadId: string | null;
    promoterThreadId: string | null;
    activeWorkerNodeId: string | null;
    activeWorkerThreadId: string | null;
  };
  nodes: Array<{ id: string; title: string; status: string }>;
  decisions: Array<{ kind: string }>;
  latestReports: {
    exploration: { summary: string; findings: string[] } | null;
    worker: Array<{ nodeId: string; outcome: string; summary: string; commands: Array<{ command: string; exitCode: number | null }> }>;
    critic: { recommendation: string; affectedNodeIds: string[] } | null;
    promotion: { summary: string } | null;
  };
};

async function v3Status(host: { harness: { behavior: { callRpc: (m: string, i: unknown) => Promise<unknown> } } }, home = HOME): Promise<Status> {
  return (await host.harness.behavior.callRpc("v3Status", { threadId: home, projectId: PROJECT })) as Status;
}

async function driveToExecuting(
  host: { harness: { behavior: { callRpc: (m: string, i: unknown) => Promise<unknown>; callAgentTool: (n: string, a: unknown, c: unknown) => Promise<unknown> } } },
  home: string,
  nodes: Array<Record<string, unknown>>,
  extra?: { presetId?: string; constraints?: string[] },
): Promise<Status> {
  await host.harness.behavior.callRpc("v3Start", {
    threadId: home,
    projectId: PROJECT,
    objective: "fix flow",
    ...(extra?.presetId ? { presetId: extra.presetId } : {}),
    ...(extra?.constraints ? { constraints: extra.constraints } : {}),
  });
  let s = await v3Status(host as never, home);
  await host.harness.behavior.callRpc("v3SkipExploration", {
    threadId: home,
    projectId: PROJECT,
    reason: "skip",
    expectedRevision: s.run.revision,
    requestId: `skip-${home}`,
  });
  s = await v3Status(host as never, home);
  await host.harness.behavior.callAgentTool("harness_submit_plan_draft", { nodes }, { threadId: s.run.plannerThreadId, projectId: PROJECT });
  s = await v3Status(host as never, home);
  await host.harness.behavior.callRpc("v3ApprovePlan", {
    threadId: home,
    projectId: PROJECT,
    expectedRevision: s.run.revision,
    requestId: `approve-${home}`,
  });
  return v3Status(host as never, home);
}

async function runWorkerToAccept(
  host: { harness: { behavior: { callRpc: (m: string, i: unknown) => Promise<unknown>; callAgentTool: (n: string, a: unknown, c: unknown) => Promise<unknown> } } },
  home: string,
  commands?: Array<{ command: string; exitCode: number | null }>,
): Promise<{ nodeId: string; workerThread: string }> {
  let s = await v3Status(host as never, home);
  await host.harness.behavior.callRpc("v3RunNextWorker", {
    threadId: home,
    projectId: PROJECT,
    expectedRevision: s.run.revision,
    requestId: `spawn-${s.run.revision}-${Date.now()}`,
  });
  s = await v3Status(host as never, home);
  const workerThread = s.run.activeWorkerThreadId!;
  const nodeId = s.run.activeWorkerNodeId!;
  await host.harness.behavior.callAgentTool(
    "harness_submit_worker_report",
    {
      outcome: "complete",
      summary: `did ${nodeId}`,
      changedFiles: [],
      commands: commands ?? [],
      artifactRefs: [],
      risks: [],
    },
    { threadId: workerThread, projectId: PROJECT },
  );
  s = await v3Status(host as never, home);
  await host.harness.behavior.callRpc("v3ReviewWorker", {
    threadId: home,
    projectId: PROJECT,
    nodeId,
    approve: true,
    expectedRevision: s.run.revision,
    requestId: `accept-${nodeId}-${Date.now()}`,
  });
  return { nodeId, workerThread };
}

describe("v3 review fixes", () => {
  let host: Awaited<ReturnType<typeof loadFix>>["host"] | undefined;
  afterEach(async () => {
    await host?.harness.lifecycle.dispose();
    host = undefined;
  });

  it("WorkerReview allows a direct transition to Critiquing", () => {
    expect(canTransitionV3("WorkerReview", "Critiquing")).toBe(true);
  });

  it("spawns first/rest workers and overrides with their resolved routing (#1)", async () => {
    ({ host } = await loadFix());
    const created = (await host.harness.behavior.callRpc("v3PresetCreate", { name: "split" })) as {
      preset: { id: string };
    };
    await host.harness.behavior.callRpc("v3PresetUpdate", {
      id: created.preset.id,
      roles: {
        workerFirst: { choice: { providerId: "pi", model: "model-first", reasoningLevel: "high" }, permissionMode: null, skillHints: [] },
        workerRest: { choice: { providerId: "acp-devin", model: "model-rest", reasoningLevel: "medium" }, permissionMode: null, skillHints: [] },
        critic: { choice: { providerId: "pi", model: "model-critic", reasoningLevel: "high" }, permissionMode: "accept-edits", skillHints: [] },
      },
    });
    let s = await driveToExecuting(host, HOME, [
      { title: "A", objective: "do A", acceptanceCriteria: ["a"] },
      { title: "B", objective: "do B", dependencies: ["A"], acceptanceCriteria: ["b"] },
    ], { presetId: created.preset.id });
    const nodeB = s.nodes.find((n) => n.title === "B")!.id;
    // Override the pending second node before it is claimed.
    await host.harness.behavior.callRpc("v3SetNodeRouting", {
      threadId: HOME,
      projectId: PROJECT,
      nodeId: nodeB,
      choice: { providerId: "pi", model: "model-override", reasoningLevel: "high" },
      expectedRevision: s.run.revision,
      requestId: "override-b",
    });
    await runWorkerToAccept(host, HOME);
    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const firstWorker = spawns.find((c) => String((c[0] as Record<string, unknown>).title).includes(": a"));
    expect(firstWorker?.[0]).toMatchObject({ providerId: "pi", model: "model-first" });
    await runWorkerToAccept(host, HOME);
    const spawnsAfter = host.harness.inspection.sdk.callsTo("threads.spawn");
    const secondWorker = [...spawnsAfter].reverse().find((c) => String((c[0] as Record<string, unknown>).title).includes(nodeB));
    expect(secondWorker?.[0]).toMatchObject({ providerId: "pi", model: "model-override" });
    // Critic spawn carries least-privilege accept-edits.
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: s.run.revision,
      requestId: "critic-1",
    });
    const criticSpawn = host.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0] as Record<string, unknown>;
    expect(criticSpawn).toMatchObject({ providerId: "pi", model: "model-critic", permissionMode: "accept-edits" });
  });

  it("accepting the final worker moves straight to Critiquing; repeat Start Critic reports already-running (#2)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [{ title: "Solo", objective: "one", acceptanceCriteria: ["ok"] }]);
    await runWorkerToAccept(host, HOME);
    const s = await v3Status(host, HOME);
    expect(s.run.state).toBe("Critiquing");
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: s.run.revision,
      requestId: "critic-once",
    });
    const s2 = await v3Status(host, HOME);
    expect(s2.run.criticThreadId).toBeTruthy();
    await expect(
      host.harness.behavior.callRpc("v3StartCritic", {
        threadId: HOME,
        projectId: PROJECT,
        expectedRevision: s2.run.revision,
        requestId: "critic-twice",
      }),
    ).rejects.toThrow(/already running/);
  });

  it("delivers Explorer output to Planner and exposes the real packet (#3, #9)", async () => {
    ({ host } = await loadFix());
    await host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "explore me" });
    let s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3RunExplorer", { threadId: HOME, projectId: PROJECT });
    s = await v3Status(host, HOME);
    const explorer = s.run.explorerThreadId!;
    const planner = s.run.plannerThreadId;
    await host.harness.behavior.callAgentTool(
      "harness_submit_exploration",
      { summary: "Found the seam", findings: ["seam in auth"], suggestedNodes: [], risks: [], artifactRefs: [] },
      { threadId: explorer, projectId: PROJECT },
    );
    const sends = host.harness.inspection.sdk.callsTo("threads.send");
    const delivery = sends.find((c) => (c[0] as Record<string, unknown>).threadId === planner);
    expect(delivery).toBeTruthy();
    expect(JSON.stringify(delivery?.[0])).toMatch(/Found the seam/);
    const ctx = (await host.harness.behavior.callAgentTool("harness_get_run_context", {}, { threadId: planner, projectId: PROJECT })) as string;
    expect(JSON.parse(ctx).exploration.summary).toMatch(/Found the seam/);
    // Stale explorer thread cannot submit a second report.
    const again = (await host.harness.behavior.callAgentTool(
      "harness_submit_exploration",
      { summary: "second", findings: [], suggestedNodes: [], risks: [], artifactRefs: [] },
      { threadId: explorer, projectId: PROJECT },
    )) as string;
    expect(again).toMatch(/already submitted|superseded|live/);
  });

  it("gives Critic all worker reports plus command verification, and keeps Start constraints (#4)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [
      { title: "A", objective: "do A", acceptanceCriteria: ["a"] },
      { title: "B", objective: "do B", dependencies: ["A"], acceptanceCriteria: ["b"] },
    ], { constraints: ["no new deps"] });
    await runWorkerToAccept(host, HOME, [{ command: "npm test", exitCode: 0 }]);
    await runWorkerToAccept(host, HOME, [{ command: "npm run lint", exitCode: 1 }]);
    let s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: s.run.revision,
      requestId: "critic-verify",
    });
    s = await v3Status(host, HOME);
    const critic = s.run.criticThreadId!;
    const review = (await host.harness.behavior.callAgentTool("harness_get_review_context", {}, { threadId: critic, projectId: PROJECT })) as string;
    const packet = JSON.parse(review) as {
      dependencyResults: Array<{ nodeId: string }>;
      verificationSummary: Array<{ command: string; exitCode: number | null; nodeId: string }>;
      constraints: string[];
    };
    expect(packet.dependencyResults).toHaveLength(2);
    expect(packet.verificationSummary.map((v) => v.command).sort()).toEqual(["npm run lint", "npm test"]);
    expect(packet.verificationSummary.find((v) => v.command === "npm run lint")).toMatchObject({ exitCode: 1 });
    expect(packet.constraints).toContain("no new deps");
  });

  it("gates promotion and completion on visible reports (#5, #6)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [{ title: "Solo", objective: "one", acceptanceCriteria: ["ok"] }]);
    await runWorkerToAccept(host, HOME);
    let s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: s.run.revision,
      requestId: "critic-gate",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callAgentTool(
      "harness_submit_critic_report",
      { recommendation: "APPROVE", findings: [{ severity: "low", title: "fine", detail: "" }], affectedNodeIds: [], unsupportedClaims: [], risks: [] },
      { threadId: s.run.criticThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    // Critic report is visible before the operator decides.
    expect(s.latestReports.critic?.recommendation).toBe("APPROVE");
    expect(s.decisions.some((d) => d.kind === "critic_approved")).toBe(false);
    await host.harness.behavior.callRpc("v3ReviewCritic", {
      threadId: HOME,
      projectId: PROJECT,
      decision: "APPROVE",
      reason: "looks good",
      expectedRevision: s.run.revision,
      requestId: "decide-approve",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3Promote", {
      threadId: HOME,
      projectId: PROJECT,
      start: true,
      expectedRevision: s.run.revision,
      requestId: "promo-start",
    });
    s = await v3Status(host, HOME);
    expect(s.run.state).toBe("Promoting");
    // Complete is blocked until the promotion report lands.
    await expect(
      host.harness.behavior.callRpc("v3Complete", {
        threadId: HOME,
        projectId: PROJECT,
        expectedRevision: s.run.revision,
        requestId: "complete-early",
      }),
    ).rejects.toThrow(/promotion report/);
    await host.harness.behavior.callAgentTool(
      "harness_submit_promotion",
      { summary: "shipped", audience: "team", channel: "notes", claims: ["done"], limitations: ["none"], artifactRefs: [] },
      { threadId: s.run.promoterThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    expect(s.latestReports.promotion?.summary).toBe("shipped");
    await host.harness.behavior.callRpc("v3Complete", {
      threadId: HOME,
      projectId: PROJECT,
      outcome: "useful",
      expectedRevision: s.run.revision,
      requestId: "complete-final",
    });
    const done = await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT });
    expect((done as Status).run?.state ?? (done as { run: null }).run).toBeTruthy();
  });

  it("resolves role children in v3Status and enforces project ownership (#12)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }]);
    const s = await v3Status(host, HOME);
    const planner = s.run.plannerThreadId;
    const viaPlanner = (await host.harness.behavior.callRpc("v3Status", { threadId: planner, projectId: PROJECT })) as Status;
    expect(viaPlanner.run.id).toBe(s.run.id);
    await expect(
      host.harness.behavior.callRpc("v3Status", { threadId: planner, projectId: "proj_other" }),
    ).rejects.toThrow(/does not match/);
  });

  it("rejects stale worker resubmits and one report per attempt (#10)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }]);
    const first = await runWorkerToAccept(host, HOME);
    const again = (await host.harness.behavior.callAgentTool(
      "harness_submit_worker_report",
      { outcome: "complete", summary: "again", changedFiles: [], artifactRefs: [], risks: [] },
      { threadId: first.workerThread, projectId: PROJECT },
    )) as string;
    expect(again).toMatch(/superseded|already submitted|live/);
    const s = await v3Status(host, HOME);
    expect(s.latestReports.worker.filter((w) => w.nodeId === first.nodeId)).toHaveLength(1);
  });

  it("short-circuits duplicate request IDs and serializes concurrent accepts (#11)", async () => {
    ({ host } = await loadFix());
    const db = host.bb.storage.database();
    // Duplicate plan submission via identical requestId applies once (Planning state).
    await host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "race" });
    let s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3SkipExploration", {
      threadId: HOME, projectId: PROJECT, reason: "skip", expectedRevision: s.run.revision, requestId: "skip-race",
    });
    s = await v3Status(host, HOME);
    const runId = s.run.id;
    const drafts = [
      { title: "A", objective: "do A", acceptanceCriteria: ["a"] },
      { title: "B", objective: "do B", dependencies: ["A"], acceptanceCriteria: ["b"] },
    ];
    const before = (db.prepare("SELECT draft_revision AS r FROM harness_v3_runs WHERE id = ?").get(runId) as { r: number }).r;
    await submitPlanDraftFromTool({ db: db as never, runId, drafts, actor: "planner", requestId: "dup-draft", update: false });
    await submitPlanDraftFromTool({ db: db as never, runId, drafts, actor: "planner", requestId: "dup-draft", update: false });
    const afterDraft = (db.prepare("SELECT draft_revision AS r FROM harness_v3_runs WHERE id = ?").get(runId) as { r: number }).r;
    expect(afterDraft - before).toBe(1);
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3ApprovePlan", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: s.run.revision,
      requestId: "approve-race",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3RunNextWorker", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: s.run.revision,
      requestId: "spawn-race",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callAgentTool(
      "harness_submit_worker_report",
      { outcome: "complete", summary: "race", changedFiles: [], artifactRefs: [], risks: [] },
      { threadId: s.run.activeWorkerThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    const rev = s.run.revision;
    const nodeId = s.run.activeWorkerNodeId!;
    const results = await Promise.allSettled([
      host.harness.behavior.callRpc("v3ReviewWorker", { threadId: HOME, projectId: PROJECT, nodeId, approve: true, expectedRevision: rev, requestId: "race-a" }),
      host.harness.behavior.callRpc("v3ReviewWorker", { threadId: HOME, projectId: PROJECT, nodeId, approve: true, expectedRevision: rev, requestId: "race-b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM harness_v3_decisions WHERE run_id = ? AND kind = 'worker_accepted'").get(runId) as { n: number }).n;
    expect(count).toBe(1);
    // Exact duplicate requestId replays without a second decision.
    s = await v3Status(host, HOME);
    const dup = await host.harness.behavior.callRpc("v3ReviewWorker", {
      threadId: HOME,
      projectId: PROJECT,
      nodeId: s.nodes.find((n) => n.status === "pending" || n.status === "ready" || n.status === "invalidated")?.id ?? nodeId,
      approve: true,
      expectedRevision: s.run.revision,
      requestId: "race-a",
    });
    expect((dup as Status).run.revision).toBe(s.run.revision);
  });

  it("duplicate critic decisions replay without a second row (#11)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [{ title: "Solo", objective: "one", acceptanceCriteria: ["ok"] }]);
    await runWorkerToAccept(host, HOME);
    let s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "critic-dup",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callAgentTool(
      "harness_submit_critic_report",
      { recommendation: "APPROVE", findings: [], affectedNodeIds: [], unsupportedClaims: [], risks: [] },
      { threadId: s.run.criticThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    const payload = {
      threadId: HOME, projectId: PROJECT, decision: "APPROVE" as const,
      reason: "good", expectedRevision: s.run.revision, requestId: "decide-dup",
    };
    await host.harness.behavior.callRpc("v3ReviewCritic", payload);
    const after = await v3Status(host, HOME);
    // Exact replay: same requestId returns current state, no new decision row.
    const replay = (await host.harness.behavior.callRpc("v3ReviewCritic", payload)) as Status;
    expect(replay.run.revision).toBe(after.run.revision);
    expect(replay.decisions.filter((d) => d.kind === "critic_approved")).toHaveLength(1);
  });

  it("duplicate node-routing requests apply once (#11)", async () => {
    ({ host } = await loadFix());
    const s = await driveToExecuting(host, HOME, [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }]);
    const db = host.bb.storage.database();
    const payload = {
      threadId: HOME,
      projectId: PROJECT,
      nodeId: s.nodes[0]!.id,
      choice: { providerId: "pi", model: "m", reasoningLevel: "high" },
      expectedRevision: s.run.revision,
      requestId: "route-dup",
    };
    await host.harness.behavior.callRpc("v3SetNodeRouting", payload);
    const rev = ((await v3Status(host, HOME)).run.revision);
    await host.harness.behavior.callRpc("v3SetNodeRouting", { ...payload, expectedRevision: rev });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM harness_v3_mutations WHERE request_id = ?").get("route-dup") as { n: number }).n;
    expect(n).toBe(1);
  });
});

describe("v3 review fixes, round two", () => {
  let host: Awaited<ReturnType<typeof loadFix>>["host"] | undefined;
  afterEach(async () => {
    await host?.harness.lifecycle.dispose();
    host = undefined;
  });

  it("blocks stale models and unsupported reasoning with clear errors (#5)", async () => {
    ({ host } = await loadFix());
    const created = (await host.harness.behavior.callRpc("v3PresetCreate", { name: "bad-models" })) as {
      preset: { id: string };
    };
    await host.harness.behavior.callRpc("v3PresetUpdate", {
      id: created.preset.id,
      roles: {
        workerFirst: { choice: { providerId: "pi", model: "ghost-model", reasoningLevel: "high" }, permissionMode: null, skillHints: [] },
      },
    });
    await expect(
      host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "x", presetId: created.preset.id }),
    ).rejects.toThrow(/stale or unknown/);
    await host.harness.behavior.callRpc("v3PresetUpdate", {
      id: created.preset.id,
      roles: {
        workerFirst: { choice: { providerId: "pi", model: "model-first", reasoningLevel: "ultra" }, permissionMode: null, skillHints: [] },
      },
    });
    await expect(
      host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "x", presetId: created.preset.id }),
    ).rejects.toThrow(/unsupported/);
  });

  it("rejects a stale node-override model at spawn time (#5)", async () => {
    ({ host } = await loadFix());
    const s = await driveToExecuting(host, HOME, [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }]);
    await host.harness.behavior.callRpc("v3SetNodeRouting", {
      threadId: HOME,
      projectId: PROJECT,
      nodeId: s.nodes[0]!.id,
      choice: { providerId: "pi", model: "ghost-model", reasoningLevel: "high" },
      expectedRevision: s.run.revision,
      requestId: "stale-override",
    });
    const s2 = await v3Status(host, HOME);
    await expect(
      host.harness.behavior.callRpc("v3RunNextWorker", {
        threadId: HOME,
        projectId: PROJECT,
        expectedRevision: s2.run.revision,
        requestId: "spawn-stale",
      }),
    ).rejects.toThrow(/Stale routing/);
  });

  it("old reports cannot approve a new attempt after rework (#1)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }]);
    const first = await runWorkerToAccept(host, HOME);
    void first;
    // Force rework via critic path is heavy; simulate retry: stop role, respawn.
    let s = await v3Status(host, HOME);
    // Second accept cycle on a fresh node state: retry the worker node.
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "c1",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callAgentTool(
      "harness_submit_critic_report",
      { recommendation: "REWORK", affectedNodeIds: [s.nodes[0]!.id], findings: [], unsupportedClaims: [], risks: [] },
      { threadId: s.run.criticThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3ReviewCritic", {
      threadId: HOME, projectId: PROJECT, decision: "REWORK", nodeIds: [s.nodes[0]!.id],
      reason: "redo", expectedRevision: s.run.revision, requestId: "rw1",
    });
    // Respawn the invalidated node; approving with only the OLD report fails.
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3RunNextWorker", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "respawn",
    });
    s = await v3Status(host, HOME);
    await expect(
      host.harness.behavior.callRpc("v3ReviewWorker", {
        threadId: HOME, projectId: PROJECT, nodeId: s.run.activeWorkerNodeId!,
        approve: true, expectedRevision: s.run.revision, requestId: "bad-accept",
      }),
    ).rejects.toThrow(/current attempt/);
    // latestReports exposes only the newest report, which belongs to attempt 1.
    expect(s.latestReports.worker).toHaveLength(1);
  });

  it("approvals do not survive a REWORK cycle; promotion and completion need a fresh decision (#2, #3)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }]);
    await runWorkerToAccept(host, HOME);
    let s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "cA",
    });
    s = await v3Status(host, HOME);
    const critic1 = s.run.criticThreadId!;
    await host.harness.behavior.callAgentTool(
      "harness_submit_critic_report",
      { recommendation: "APPROVE", findings: [], affectedNodeIds: [], unsupportedClaims: [], risks: [] },
      { threadId: critic1, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3ReviewCritic", {
      threadId: HOME, projectId: PROJECT, decision: "APPROVE", reason: "v1 ok",
      expectedRevision: s.run.revision, requestId: "dec-v1",
    });
    s = await v3Status(host, HOME);
    expect(s.currentReviewApproved).toBe(true);
    // Second decision for the same report is rejected.
    await expect(
      host.harness.behavior.callRpc("v3ReviewCritic", {
        threadId: HOME, projectId: PROJECT, decision: "REWORK", nodeIds: [s.nodes[0]!.id],
        reason: "changed mind", expectedRevision: s.run.revision, requestId: "dec-v1b",
      }),
    ).rejects.toThrow(/already recorded/);
    // New critic cycle via retry → new report → old approval is stale.
    await host.harness.behavior.callRpc("v3RetryRole", {
      threadId: HOME, projectId: PROJECT, role: "critic",
      expectedRevision: s.run.revision, requestId: "retry-c",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "cB",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callAgentTool(
      "harness_submit_critic_report",
      { recommendation: "APPROVE", findings: [], affectedNodeIds: [], unsupportedClaims: [], risks: [] },
      { threadId: s.run.criticThreadId!, projectId: PROJECT },
    );
    // Hmm: retry cleared the thread but the approval from v1 is still newer than... no:
    // the new report (now) is newer than the v1 approval, so approval is stale.
    s = await v3Status(host, HOME);
    expect(s.currentReviewApproved).toBe(false);
    await expect(
      host.harness.behavior.callRpc("v3Promote", {
        threadId: HOME, projectId: PROJECT, start: true,
        expectedRevision: s.run.revision, requestId: "promo-stale",
      }),
    ).rejects.toThrow(/current Critic approval/);
    await expect(
      host.harness.behavior.callRpc("v3Complete", {
        threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "done-stale",
      }),
    ).rejects.toThrow(/current Critic approval/);
  });

  it("exports accepted reports to promised paths and records artifact rows (#4)", async () => {
    ({ host } = await loadFix());
    await host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "artifacts" });
    let s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3RunExplorer", { threadId: HOME, projectId: PROJECT });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callAgentTool(
      "harness_submit_exploration",
      { summary: "scan", findings: [], suggestedNodes: [], risks: [], artifactRefs: [] },
      { threadId: s.run.explorerThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3AcceptExploration", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "acc-exp",
    });
    const writes = host.harness.inspection.sdk.callsTo("files.write");
    const paths = writes.map((c) => (c[0] as Record<string, unknown>).path as string);
    expect(paths.some((p) => String(p).endsWith("exploration.md"))).toBe(true);
    const db = host.bb.storage.database();
    const rows = db.prepare("SELECT path, kind FROM harness_v3_artifacts WHERE run_id = ?").all(s.run.id) as Array<{ path: string; kind: string }>;
    expect(rows.some((r) => r.kind === "exploration" && r.path.endsWith("exploration.md"))).toBe(true);
  });

  it("surfaces export failure as a warning with retry instead of false success (#4)", async () => {
    ({ host } = await loadFix());
    const sdk = host.harness.inspection.sdk;
    await host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "export-fail" });
    let s = await v3Status(host, HOME);
    // Fail every file write from here on.
    host.harness.sdk.stub("files.write", async () => {
      throw new Error("disk gone");
    });
    await host.harness.behavior.callRpc("v3RunExplorer", { threadId: HOME, projectId: PROJECT });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callAgentTool(
      "harness_submit_exploration",
      { summary: "scan", findings: [], suggestedNodes: [], risks: [], artifactRefs: [] },
      { threadId: s.run.explorerThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3AcceptExploration", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "acc-exp-fail",
    });
    s = await v3Status(host, HOME);
    expect(s.exportWarnings.length).toBeGreaterThan(0);
    expect(sdk.callsTo("files.write").length).toBeGreaterThan(0);
    void sdk;
  });

  it("promotion skip is idempotent and one-way per review (#3)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }]);
    await runWorkerToAccept(host, HOME);
    let s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "cS",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callAgentTool(
      "harness_submit_critic_report",
      { recommendation: "APPROVE", findings: [], affectedNodeIds: [], unsupportedClaims: [], risks: [] },
      { threadId: s.run.criticThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3ReviewCritic", {
      threadId: HOME, projectId: PROJECT, decision: "APPROVE", reason: "ok",
      expectedRevision: s.run.revision, requestId: "decS",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3Promote", {
      threadId: HOME, projectId: PROJECT, start: false,
      expectedRevision: s.run.revision, requestId: "skip1",
    });
    s = await v3Status(host, HOME);
    expect(s.promotionSkipped).toBe(true);
    const rev = s.run.revision;
    await host.harness.behavior.callRpc("v3Promote", {
      threadId: HOME, projectId: PROJECT, start: false,
      expectedRevision: rev, requestId: "skip2",
    });
    const s2 = await v3Status(host, HOME);
    expect(s2.run.revision).toBe(rev);
    expect(s2.decisions.filter((d) => d.kind === "promotion_skipped")).toHaveLength(1);
  });

  it("blocked and plan-change-needed outcomes cannot be accepted; plan-change returns to Planning (#12)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }]);
    let s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3RunNextWorker", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "sp1",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callAgentTool(
      "harness_submit_worker_report",
      { outcome: "blocked", summary: "stuck", changedFiles: [], artifactRefs: [], risks: [] },
      { threadId: s.run.activeWorkerThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    await expect(
      host.harness.behavior.callRpc("v3ReviewWorker", {
        threadId: HOME, projectId: PROJECT, nodeId: s.run.activeWorkerNodeId!,
        approve: true, expectedRevision: s.run.revision, requestId: "badacc",
      }),
    ).rejects.toThrow(/Cannot accept/);
    // Second node for the plan-change path.
    const host2 = host;
    void host2;
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3ReviewWorker", {
      threadId: HOME, projectId: PROJECT, nodeId: s.run.activeWorkerNodeId!,
      approve: false, changes: "needs plan edit", expectedRevision: s.run.revision, requestId: "chg1",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3RunNextWorker", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "sp2",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callAgentTool(
      "harness_submit_worker_report",
      { outcome: "plan-change-needed", summary: "plan is wrong", changedFiles: [], artifactRefs: [], risks: [] },
      { threadId: s.run.activeWorkerThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3ReviewWorker", {
      threadId: HOME, projectId: PROJECT, nodeId: s.run.activeWorkerNodeId!,
      approve: false, changes: "revise DAG", expectedRevision: s.run.revision, requestId: "chg2",
    });
    s = await v3Status(host, HOME);
    expect(s.run.state).toBe("Planning");
  });

  it("role failures land in recoverable states with retry paths (#10)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }]);
    let s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3RunNextWorker", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "spW",
    });
    s = await v3Status(host, HOME);
    const workerThread = s.run.activeWorkerThreadId!;
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: { id: workerThread } as never,
      error: "boom",
    });
    await new Promise((r) => setImmediate(r));
    s = await v3Status(host, HOME);
    expect(s.run.state).toBe("Executing");
    expect(s.failedRoles.some((f) => f.role === "worker")).toBe(true);
    // Stale failure events for superseded threads reconcile nothing.
    const revBefore = s.run.revision;
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: { id: workerThread } as never,
      error: "late",
    });
    await new Promise((r) => setImmediate(r));
    s = await v3Status(host, HOME);
    expect(s.run.revision).toBe(revBefore);
  });

  it("planner failure is retried with a fresh planner thread (#10)", async () => {
    ({ host } = await loadFix());
    await host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "planfail" });
    let s = await v3Status(host, HOME);
    const planner1 = s.run.plannerThreadId;
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: { id: planner1 } as never,
      error: "planner down",
    });
    await new Promise((r) => setImmediate(r));
    s = await v3Status(host, HOME);
    expect(s.failedRoles.some((f) => f.role === "planner")).toBe(true);
    await host.harness.behavior.callRpc("v3RetryRole", {
      threadId: HOME, projectId: PROJECT, role: "planner",
      expectedRevision: s.run.revision, requestId: "retry-planner",
    });
    s = await v3Status(host, HOME);
    expect(s.run.plannerThreadId).not.toBe(planner1);
    expect(s.failedRoles.some((f) => f.role === "planner")).toBe(false);
  });

  it("promoter failure clears the thread and promotion can restart (#10)", async () => {
    ({ host } = await loadFix());
    await driveToExecuting(host, HOME, [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }]);
    await runWorkerToAccept(host, HOME);
    let s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "cP",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callAgentTool(
      "harness_submit_critic_report",
      { recommendation: "APPROVE", findings: [], affectedNodeIds: [], unsupportedClaims: [], risks: [] },
      { threadId: s.run.criticThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3ReviewCritic", {
      threadId: HOME, projectId: PROJECT, decision: "APPROVE", reason: "ok",
      expectedRevision: s.run.revision, requestId: "decP",
    });
    s = await v3Status(host, HOME);
    await host.harness.behavior.callRpc("v3Promote", {
      threadId: HOME, projectId: PROJECT, start: true,
      expectedRevision: s.run.revision, requestId: "promoP",
    });
    s = await v3Status(host, HOME);
    const promoter = s.run.promoterThreadId!;
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: { id: promoter } as never,
      error: "promo down",
    });
    await new Promise((r) => setImmediate(r));
    s = await v3Status(host, HOME);
    expect(s.run.state).toBe("Promoting");
    expect(s.failedRoles.some((f) => f.role === "promoter")).toBe(true);
    await host.harness.behavior.callRpc("v3Promote", {
      threadId: HOME, projectId: PROJECT, start: true,
      expectedRevision: s.run.revision, requestId: "promoP2",
    });
    s = await v3Status(host, HOME);
    expect(s.run.promoterThreadId).not.toBe(promoter);
  });

  it("project presets are isolated by project (#6)", async () => {
    ({ host } = await loadFix());
    const created = (await host.harness.behavior.callRpc("v3PresetCreate", {
      name: "proj-only", scope: "project", projectId: PROJECT,
    })) as { preset: { id: string } };
    const listed = (await host.harness.behavior.callRpc("v3PresetList", { projectId: PROJECT })) as {
      presets: Array<{ id: string }>;
    };
    expect(listed.presets.some((p) => p.id === created.preset.id)).toBe(true);
    const other = (await host.harness.behavior.callRpc("v3PresetList", { projectId: "proj_elsewhere" })) as {
      presets: Array<{ id: string }>;
    };
    expect(other.presets.some((p) => p.id === created.preset.id)).toBe(false);
    // A caller spoofing another project id cannot start with it.
    const spoofed = host;
    void spoofed;
    await expect(
      host.harness.behavior.callRpc("v3Start", {
        threadId: HOME, projectId: "proj_elsewhere", objective: "x", presetId: created.preset.id,
      }),
    ).rejects.toThrow();
  });
});

describe("v3 final review fixes", () => {
  let host: Awaited<ReturnType<typeof loadFix>>["host"] | undefined;
  afterEach(async () => {
    await host?.harness.lifecycle.dispose();
    host = undefined;
  });

  it("accepts valid Pi selections routed behind opencode and rejects unavailable providers (#1-route)", async () => {
    ({ host } = await loadFix({
      providers: [{ id: "pi" }, { id: "acp-devin" }, { id: "dead", available: false } as never],
    }));
    const created = (await host.harness.behavior.callRpc("v3PresetCreate", { name: "pi-routed" })) as {
      preset: { id: string };
    };
    // opencode-routed Muse model behind pi must validate.
    await host.harness.behavior.callRpc("v3PresetUpdate", {
      id: created.preset.id,
      roles: {
        planner: { choice: { providerId: "pi", model: "opencode/muse-spark-1.3-contributor-free", reasoningLevel: "high" }, permissionMode: null, skillHints: [] },
        explorer: { choice: null, permissionMode: null, skillHints: [] },
        workerFirst: { choice: null, permissionMode: null, skillHints: [] },
        workerRest: { choice: null, permissionMode: null, skillHints: [] },
        critic: { choice: null, permissionMode: null, skillHints: [] },
        promoter: { choice: null, permissionMode: null, skillHints: [] },
      },
    });
    await host.harness.behavior.callRpc("v3Start", {
      threadId: HOME, projectId: PROJECT, objective: "pi routed", presetId: created.preset.id,
    });
    const s = await v3Status(host, HOME);
    expect(s.run.state).toBe("Exploring");
    // available:false entries block even when listed.
    await host.harness.behavior.callRpc("v3PresetUpdate", {
      id: created.preset.id,
      roles: {
        explorer: { choice: { providerId: "dead", model: "m", reasoningLevel: "high" }, permissionMode: null, skillHints: [] },
      },
    });
    await expect(
      host.harness.behavior.callRpc("v3Start", {
        threadId: HOME2, projectId: PROJECT, objective: "dead", presetId: created.preset.id,
      }),
    ).rejects.toThrow(/unavailable/);
  });

  it("orders same-millisecond report/decision rows by identity, not timestamps (#2-clock)", async () => {
    ({ host } = await loadFix());
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await driveToExecuting(host, HOME, [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }]);
      await runWorkerToAccept(host, HOME);
      let s = await v3Status(host, HOME);
      await host.harness.behavior.callRpc("v3StartCritic", {
        threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "cc1",
      });
      s = await v3Status(host, HOME);
      await host.harness.behavior.callAgentTool(
        "harness_submit_critic_report",
        { recommendation: "APPROVE", findings: [], affectedNodeIds: [], unsupportedClaims: [], risks: [] },
        { threadId: s.run.criticThreadId!, projectId: PROJECT },
      );
      s = await v3Status(host, HOME);
      await host.harness.behavior.callRpc("v3ReviewCritic", {
        threadId: HOME, projectId: PROJECT, decision: "APPROVE", reason: "v1",
        expectedRevision: s.run.revision, requestId: "dd1",
      });
      s = await v3Status(host, HOME);
      expect(s.currentReviewApproved).toBe(true);
      // New report in the SAME millisecond must invalidate the old approval:
      // every timestamp in the run is identical, so only IDs can order them.
      await host.harness.behavior.callRpc("v3RetryRole", {
        threadId: HOME, projectId: PROJECT, role: "critic",
        expectedRevision: s.run.revision, requestId: "rc1",
      });
      s = await v3Status(host, HOME);
      await host.harness.behavior.callRpc("v3StartCritic", {
        threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "cc2",
      });
      s = await v3Status(host, HOME);
      await host.harness.behavior.callAgentTool(
        "harness_submit_critic_report",
        { recommendation: "APPROVE", findings: [], affectedNodeIds: [], unsupportedClaims: [], risks: [] },
        { threadId: s.run.criticThreadId!, projectId: PROJECT },
      );
      s = await v3Status(host, HOME);
      expect(s.currentReviewApproved).toBe(false);
      await expect(
        host.harness.behavior.callRpc("v3Complete", {
          threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "doneX",
        }),
      ).rejects.toThrow(/current Critic approval/);
    } finally {
      now.mockRestore();
    }
  });
});
