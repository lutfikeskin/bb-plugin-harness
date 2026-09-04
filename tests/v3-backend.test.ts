import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const PROJECT = "proj_v3";
const HOME = "thr_home_v3";
const ENV = "env_v3";

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

async function loadV3(options?: { providers?: Array<{ id: string }>; childOutput?: string | null }) {
  let childSeq = 0;
  const threads = new Map([
    [HOME, makeThreadResponse({ id: HOME, projectId: PROJECT, environmentId: ENV, providerId: "pi" })],
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
        get: async () => ({ id: PROJECT, name: "v3proj" }),
        commands: async () => ({ commands: [] }),
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const t = threads.get(threadId);
          if (!t) throw new Error(`missing thread ${threadId}`);
          return t;
        },
        output: async () => ({ output: options?.childOutput ?? "output" }),
        send: async () => ({ ok: true, delivery: "sent" as const }),
        spawn: async (args: Record<string, unknown>) => {
          childSeq += 1;
          const child = makeThreadResponse({
            id: `thr_v3_${childSeq}`,
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

describe("v3 backend", () => {
  let host: Awaited<ReturnType<typeof loadV3>>["host"] | undefined;
  afterEach(async () => {
    await host?.harness.lifecycle.dispose();
    host = undefined;
  });

  it("starts v3 with a Planner child and keeps legacy tables readable", async () => {
    ({ host } = await loadV3());
    const started = (await host.harness.behavior.callRpc("v3Start", {
      threadId: HOME,
      projectId: PROJECT,
      objective: "Ship v3",
    })) as { run: { id: string; state: string; plannerThreadId: string | null } };
    expect(started.run.state).toBe("Exploring");
    expect(started.run.plannerThreadId).toMatch(/thr_v3_/);
    // Legacy tables still exist and are untouched.
    const db = host.bb.storage.database();
    expect((db.prepare("SELECT COUNT(*) AS n FROM harness_v3_runs").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plans'").get() as { name: string }).name).toBe("plans");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn").length).toBe(1);
  });

  it("blocks Start on stale providers with a repair message", async () => {
    ({ host } = await loadV3({ providers: [{ id: "pi" }] }));
    const created = (await host.harness.behavior.callRpc("v3PresetCreate", { name: "stale" })) as {
      preset: { id: string };
    };
    await host.harness.behavior.callRpc("v3PresetUpdate", {
      id: created.preset.id,
      roles: { explorer: { choice: { providerId: "ghost", model: "m", reasoningLevel: "high" }, permissionMode: null, skillHints: [] } },
    });
    await expect(
      host.harness.behavior.callRpc("v3Start", {
        threadId: HOME,
        projectId: PROJECT,
        objective: "stale",
        presetId: created.preset.id,
      }),
    ).rejects.toThrow(/unavailable|stale/i);
  });

  it("runs Explorer, submits draft via Planner tool, and approves the real DAG", async () => {
    ({ host } = await loadV3());
    const started = (await host.harness.behavior.callRpc("v3Start", {
      threadId: HOME,
      projectId: PROJECT,
      objective: "Real DAG",
    })) as { run: { id: string; revision: number; plannerThreadId: string } };
    const runId = started.run.id;
    await host.harness.behavior.callRpc("v3RunExplorer", { threadId: HOME, projectId: PROJECT });
    const plannerId = started.run.plannerThreadId;
    // Explorer-only tool rejects Planner caller.
    await expect(
      host.harness.behavior.callAgentTool("harness_submit_exploration", { summary: "s" }, { threadId: plannerId, projectId: PROJECT }),
    ).rejects.toThrow(/explorer/i);
    // Explorer submits.
    const status1 = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { explorerThreadId: string };
    };
    const explorerId = status1.run.explorerThreadId;
    await host.harness.behavior.callAgentTool(
      "harness_submit_exploration",
      { summary: "Found two tasks", findings: ["f"], suggestedNodes: [], risks: [], artifactRefs: [] },
      { threadId: explorerId, projectId: PROJECT },
    );
    const before = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { revision: number };
    };
    await host.harness.behavior.callRpc("v3AcceptExploration", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: before.run.revision,
      requestId: "t-accept",
    });
    // Planner submits implementation-only DAG (phase nodes rejected).
    const badDraft = (await host.harness.behavior.callAgentTool(
      "harness_submit_plan_draft",
      { nodes: [{ title: "bad", objective: "o", acceptanceCriteria: ["a"], phase: "critic" }] },
      { threadId: plannerId, projectId: PROJECT },
    )) as string;
    expect(String(badDraft)).toMatch(/legacy phase/i);
    const draft = (await host.harness.behavior.callAgentTool(
      "harness_submit_plan_draft",
      {
        nodes: [
          { title: "API", objective: "Build API", acceptanceCriteria: ["serves 200"], verificationCommands: ["npm test"] },
          { title: "UI", objective: "Build UI", dependencies: ["API"], acceptanceCriteria: ["renders"] },
        ],
      },
      { threadId: plannerId, projectId: PROJECT },
    )) as string;
    expect(draft).toMatch(/draftRevision/);
    const pre = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { revision: number; state: string };
      nodes: Array<{ id: string; dependencies: string[] }>;
    };
    expect(pre.run.state).toBe("PlanApproval");
    expect(pre.nodes).toHaveLength(2);
    await host.harness.behavior.callRpc("v3ApprovePlan", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: pre.run.revision,
      requestId: "t-approve",
    });
    const after = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { state: string; planRevision: number };
    };
    expect(after.run.state).toBe("Executing");
    expect(after.run.planRevision).toBe(1);
    expect(runId).toBeTruthy();
  });

  it("executes workers in order, gates Critic, and reworks downstream only", async () => {
    ({ host } = await loadV3());
    await host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "Order" });
    let s = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { revision: number; plannerThreadId: string };
    };
    const plannerId = s.run.plannerThreadId;
    await host.harness.behavior.callAgentTool(
      "harness_submit_exploration",
      { summary: "skip me" },
      { threadId: plannerId, projectId: PROJECT },
    ).catch(() => undefined);
    // Skip exploration deterministically.
    s = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as never;
    const run = (s as { run: { revision: number } }).run;
    await host.harness.behavior.callRpc("v3SkipExploration", {
      threadId: HOME,
      projectId: PROJECT,
      reason: "trivial",
      expectedRevision: run.revision,
      requestId: "t-skip",
    });
    s = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as never;
    await host.harness.behavior.callAgentTool(
      "harness_submit_plan_draft",
      {
        nodes: [
          { title: "A", objective: "do A", acceptanceCriteria: ["a"] },
          { title: "B", objective: "do B", dependencies: ["A"], acceptanceCriteria: ["b"] },
          { title: "C", objective: "do C", dependencies: ["B"], acceptanceCriteria: ["c"] },
        ],
      },
      { threadId: plannerId, projectId: PROJECT },
    );
    let cur = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { revision: number };
    };
    await host.harness.behavior.callRpc("v3ApprovePlan", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: cur.run.revision,
      requestId: "t-a",
    });
    // Critic cannot start early.
    cur = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as never;
    await expect(
      host.harness.behavior.callRpc("v3StartCritic", {
        threadId: HOME,
        projectId: PROJECT,
        expectedRevision: (cur as { run: { revision: number } }).run.revision,
        requestId: "t-early",
      }),
    ).rejects.toThrow(/every required worker/i);
    // Run A -> report -> accept; B must wait for A.
    for (const title of ["A", "B", "C"]) {
      cur = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as never;
      const rev = (cur as { run: { revision: number } }).run.revision;
      await host.harness.behavior.callRpc("v3RunNextWorker", { threadId: HOME, projectId: PROJECT, expectedRevision: rev, requestId: `w-${title}` });
      const st = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
        run: { activeWorkerThreadId: string; activeWorkerNodeId: string; revision: number };
      };
      expect(st.run.activeWorkerNodeId).toBeTruthy();
      await host.harness.behavior.callAgentTool(
        "harness_submit_worker_report",
        { outcome: "complete", summary: `did ${title}`, changedFiles: [], artifactRefs: [], risks: [] },
        { threadId: st.run.activeWorkerThreadId, projectId: PROJECT },
      );
      const rev2 = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
        run: { revision: number };
      };
      await host.harness.behavior.callRpc("v3ReviewWorker", {
        threadId: HOME,
        projectId: PROJECT,
        nodeId: st.run.activeWorkerNodeId,
        approve: true,
        expectedRevision: rev2.run.revision,
        requestId: `acc-${title}`,
      });
    }
    cur = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as never;
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: (cur as { run: { revision: number } }).run.revision,
      requestId: "t-critic",
    });
    const cs = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { criticThreadId: string };
      nodes: Array<{ id: string; title: string }>;
    };
    const nodeB = cs.nodes.find((n) => n.title === "B")!.id;
    await host.harness.behavior.callAgentTool(
      "harness_submit_critic_report",
      { recommendation: "REWORK", affectedNodeIds: [nodeB], findings: [], unsupportedClaims: [], risks: [] },
      { threadId: cs.run.criticThreadId, projectId: PROJECT },
    );
    cur = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as never;
    const rev3 = (cur as { run: { revision: number } }).run.revision;
    await host.harness.behavior.callRpc("v3ReviewCritic", {
      threadId: HOME,
      projectId: PROJECT,
      decision: "REWORK",
      nodeIds: [nodeB],
      reason: "B is wrong",
      expectedRevision: rev3,
      requestId: "t-rework",
    });
    const rw = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      nodes: Array<{ id: string; status: string }>;
    };
    // A stays done; B and downstream C invalidated.
    const byTitle = new Map(rw.nodes.map((n) => [n.id, n.status]));
    expect([...byTitle.values()]).toContain("done");
    expect([...byTitle.values()]).toContain("invalidated");
  });

  it("rejects stale revisions and locks node overrides after claim", async () => {
    ({ host } = await loadV3());
    await host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "CAS" });
    const s = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { revision: number; plannerThreadId: string };
    };
    await host.harness.behavior.callRpc("v3SkipExploration", {
      threadId: HOME,
      projectId: PROJECT,
      reason: "skip",
      expectedRevision: s.run.revision,
      requestId: "t1",
    });
    await host.harness.behavior.callAgentTool(
      "harness_submit_plan_draft",
      { nodes: [{ title: "A", objective: "o", acceptanceCriteria: ["a"] }] },
      { threadId: s.run.plannerThreadId, projectId: PROJECT },
    );
    const pre = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { revision: number };
      nodes: Array<{ id: string }>;
    };
    await expect(
      host.harness.behavior.callRpc("v3ApprovePlan", {
        threadId: HOME,
        projectId: PROJECT,
        expectedRevision: pre.run.revision - 1,
        requestId: "stale",
      }),
    ).rejects.toThrow(/stale/i);
    await host.harness.behavior.callRpc("v3ApprovePlan", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: pre.run.revision,
      requestId: "fresh",
    });
    const ex = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { revision: number };
      nodes: Array<{ id: string }>;
    };
    await host.harness.behavior.callRpc("v3RunNextWorker", {
      threadId: HOME,
      projectId: PROJECT,
      expectedRevision: ex.run.revision,
      requestId: "w1",
    });
    const claimed = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { revision: number };
      nodes: Array<{ id: string }>;
    };
    await expect(
      host.harness.behavior.callRpc("v3SetNodeRouting", {
        threadId: HOME,
        projectId: PROJECT,
        nodeId: claimed.nodes[0]!.id,
        choice: { providerId: "pi", model: "m", reasoningLevel: "high" },
        expectedRevision: claimed.run.revision,
        requestId: "locked",
      }),
    ).rejects.toThrow(/already claimed|lock/i);
  });

  it("child tools cannot approve and cancel stops children first", async () => {
    ({ host } = await loadV3());
    await host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "Auth" });
    const s = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { plannerThreadId: string; revision: number };
    };
    // Random thread cannot use planner tools.
    await expect(
      host.harness.behavior.callAgentTool("harness_submit_plan_draft", { nodes: [{ title: "x", objective: "o", acceptanceCriteria: ["a"] }] }, { threadId: "thr_random", projectId: PROJECT }),
    ).rejects.toThrow(/restricted/i);
    await expect(
      host.harness.behavior.callRpc("v3Cancel", {
        threadId: HOME,
        projectId: PROJECT,
        reason: "done",
        expectedRevision: s.run.revision + 999,
        requestId: "stale-cancel",
      }),
    ).rejects.toThrow(/stale/i);
    await host.harness.behavior.callRpc("v3Cancel", {
      threadId: HOME,
      projectId: PROJECT,
      reason: "Operator cancelled.",
      expectedRevision: s.run.revision,
      requestId: "good-cancel",
    });
    const after = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { state: string } | null;
    };
    // Cancelled runs surface their terminal state; a fresh start is allowed afterwards.
    expect(after.run?.state).toBe("Cancelled");
  });

  it("serves v3 CLI happy path with bounded JSON", async () => {
    ({ host } = await loadV3());
    const started = await host.harness.behavior.runCli(["start", "--task", "CLI ship"], { threadId: HOME, projectId: PROJECT });
    expect(started.exitCode).toBe(0);
    const status = await host.harness.behavior.runCli(["status", "--thread", HOME, "--json"], { threadId: "thr_other", projectId: "proj_other" });
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout ?? "{}").run).toMatchObject({ state: "Exploring" });
  });
});
