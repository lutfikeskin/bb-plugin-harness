import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { ROLE_SPAWN_DISPATCH_DELAY_MS } from "../lib/v3-backend";

// The role-spawn dispatch race: the host runs bb.agents.configure during
// thread creation, potentially before the attempt/run mapping is persisted.
// Every spawn through spawnRoleThread therefore (a) schedules first dispatch
// in the future via sendAt, and (b) notes a pre-spawn intent (parent, exact
// title, origin-gated) that configure consults as a fallback.
//
// These tests prove the fallback deterministically: the fake threads.spawn
// implementation itself invokes resolveAgentConfiguration synchronously
// INSIDE the spawn call — before spawn returns and before the plugin writes
// any mapping — exactly the interleaving the live incident showed.

const PROJECT = "proj_race";
const HOME = "thr_race_home";
const ENV = "env_race";

type InFlightCheck = {
  title: string;
  tools: string[];
  repeatedTools: string[];
  wrongTitleTools: string[];
  wrongOriginTools: string[];
};

async function loadRace(spawnImpl?: (args: Record<string, unknown>, next: (args: Record<string, unknown>) => Promise<{ id: string }>) => Promise<{ id: string }>) {
  let childSeq = 0;
  const threads = new Map([
    [HOME, makeThreadResponse({ id: HOME, projectId: PROJECT, environmentId: ENV, providerId: "pi" })],
  ]);
  const spawnTimes: number[] = [];
  const inFlight: InFlightCheck[] = [];
  // Assigned after creation; spawns only happen via later RPCs.
  let hostRef: { harness: { behavior: { resolveAgentConfiguration: (ctx: never) => Promise<{ tools: Array<{ name: string }> }> } } } | undefined;
  const agentCtx = (threadId: string, parentThreadId: string | null, title: string | null, originPluginId: string | null) => ({
    thread: { id: threadId, title, parentThreadId, sourceThreadId: null },
    project: { id: PROJECT, kind: "standard", name: "test", gitRemoteUrl: null },
    environment: { id: ENV, name: null, path: "/tmp/ws", workspaceProvisionType: "unmanaged", branchName: null },
    host: { id: "host_1", name: "host" },
    provider: { id: "pi", model: "m", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: originPluginId },
  });
  const toolNames = async (threadId: string, parentThreadId: string | null, title: string | null, originPluginId: string | null) => {
    const config = await hostRef!.harness.behavior.resolveAgentConfiguration(agentCtx(threadId, parentThreadId, title, originPluginId) as never);
    return config.tools.map((tool) => tool.name);
  };
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
          providers: [
            { id: "pi", available: true },
            { id: "acp-devin", available: true },
            { id: "acp-cursor", available: true },
          ],
          models: [
            { model: "swe-1-7-medium", routeProviderId: "acp-devin", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "m" }] },
            { model: "openai-codex/gpt-5.6-sol", routeProviderId: "openai-codex", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "h" }] },
            { model: "opencode/muse-spark-1.3-contributor-free", routeProviderId: "opencode", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "h" }] },
            { model: "grok-4.6", routeProviderId: "cursor", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "h" }] },
          ],
        }),
        list: async () => [{ id: "pi" }],
      },
      skills: {
        list: async () => ({ skills: [] }),
      },
      projects: {
        get: async () => ({ id: PROJECT, name: "raceproj" }),
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
          spawnTimes.push(Date.now());
          const create = async (a: Record<string, unknown>) => {
            childSeq += 1;
            const child = makeThreadResponse({
              id: `thr_race_${childSeq}`,
              projectId: PROJECT,
              environmentId: ENV,
              parentThreadId: String(a.parentThreadId),
            });
            threads.set(child.id, child);
            return child;
          };
          const child = spawnImpl ? await spawnImpl(args, create) : await create(args);
          // Host-side interleaving: configure runs during creation, before
          // spawn returns and before the plugin persists its mapping.
          const parent = String(args.parentThreadId);
          const title = String(args.title ?? "");
          const tools = await toolNames(child.id, parent, title, "harness");
          const repeatedTools = await toolNames(child.id, parent, title, "harness");
          const wrongTitleTools = await toolNames("thr_unrelated_a", parent, `${title} (copy)`, "harness");
          const wrongOriginTools = await toolNames("thr_unrelated_b", parent, title, null);
          inFlight.push({ title, tools, repeatedTools, wrongTitleTools, wrongOriginTools });
          return child;
        },
        stop: async ({ threadId }: { threadId: string }) => threads.get(threadId),
        events: { list: async () => [] },
      },
    },
  });
  await plugin(host.bb);
  hostRef = host as never;
  return { host, threads, spawnTimes, inFlight, toolNames };
}

type V3Status = {
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
};

async function v3Status(host: { harness: { behavior: { callRpc: (m: string, i: unknown) => Promise<unknown> } } }): Promise<V3Status> {
  return (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as V3Status;
}

const EXPECTED_TOOLS: Record<string, string> = {
  planner: "harness_submit_plan_draft",
  explorer: "harness_submit_exploration",
  workerFirst: "harness_submit_worker_report",
  critic: "harness_submit_critic_report",
  promoter: "harness_submit_promotion",
};

describe("v3 spawn dispatch race", () => {
  let ctx: Awaited<ReturnType<typeof loadRace>> | undefined;
  afterEach(async () => {
    await ctx?.host.harness.lifecycle.dispose();
    ctx = undefined;
  });

  it("in-spawn configure resolves every role, rejects strangers, and defers dispatch", async () => {
    ctx = await loadRace();
    const { host, spawnTimes, inFlight, toolNames } = ctx;
    await host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "race arc" });
    let s = await v3Status(host);
    const planner = s.run.plannerThreadId;
    await host.harness.behavior.callRpc("v3RunExplorer", { threadId: HOME, projectId: PROJECT });
    s = await v3Status(host);
    await host.harness.behavior.callRpc("v3SkipExploration", {
      threadId: HOME, projectId: PROJECT, reason: "skip", expectedRevision: s.run.revision, requestId: "skip-race",
    });
    s = await v3Status(host);
    await host.harness.behavior.callAgentTool(
      "harness_submit_plan_draft",
      { nodes: [{ title: "A", objective: "do A", acceptanceCriteria: ["a"] }] },
      { threadId: planner, projectId: PROJECT },
    );
    s = await v3Status(host);
    await host.harness.behavior.callRpc("v3ApprovePlan", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "approve-race",
    });
    s = await v3Status(host);
    await host.harness.behavior.callRpc("v3RunNextWorker", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "spawn-race",
    });
    s = await v3Status(host);
    await host.harness.behavior.callAgentTool(
      "harness_submit_worker_report",
      { outcome: "complete", summary: "did A", changedFiles: [], artifactRefs: [], risks: [] },
      { threadId: s.run.activeWorkerThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host);
    await host.harness.behavior.callRpc("v3ReviewWorker", {
      threadId: HOME, projectId: PROJECT, nodeId: s.run.activeWorkerNodeId!,
      approve: true, expectedRevision: s.run.revision, requestId: "accept-race",
    });
    s = await v3Status(host);
    await host.harness.behavior.callRpc("v3StartCritic", {
      threadId: HOME, projectId: PROJECT, expectedRevision: s.run.revision, requestId: "critic-race",
    });
    s = await v3Status(host);
    await host.harness.behavior.callAgentTool(
      "harness_submit_critic_report",
      { recommendation: "APPROVE", findings: [], affectedNodeIds: [], unsupportedClaims: [], risks: [] },
      { threadId: s.run.criticThreadId!, projectId: PROJECT },
    );
    s = await v3Status(host);
    await host.harness.behavior.callRpc("v3ReviewCritic", {
      threadId: HOME, projectId: PROJECT, decision: "APPROVE", reason: "ok",
      expectedRevision: s.run.revision, requestId: "decide-race",
    });
    s = await v3Status(host);
    await host.harness.behavior.callRpc("v3Promote", {
      threadId: HOME, projectId: PROJECT, start: true,
      expectedRevision: s.run.revision, requestId: "promo-race",
    });
    s = await v3Status(host);

    // All five role spawns ran configure mid-flight; each resolved its role.
    expect(inFlight.length).toBe(5);
    const seenRoles = new Set<string>();
    for (const check of inFlight) {
      const role = check.title.replace(/^Harness /, "").split(":")[0]!;
      seenRoles.add(role);
      expect(check.tools).toContain(EXPECTED_TOOLS[role]);
      // Repeated configures while in flight keep resolving (no consumption).
      expect(check.repeatedTools).toEqual(check.tools);
      // Unrelated title or non-plugin origin resolves nothing.
      expect(check.wrongTitleTools).toEqual([]);
      expect(check.wrongOriginTools).toEqual([]);
    }
    expect(seenRoles).toEqual(new Set(["planner", "explorer", "workerFirst", "critic", "promoter"]));

    // Belt: every spawn deferred first dispatch into the future.
    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawns.length).toBe(5);
    spawns.forEach((call, index) => {
      const args = call[0] as Record<string, unknown>;
      expect(typeof args.sendAt).toBe("number");
      const skew = (args.sendAt as number) - spawnTimes[index]!;
      expect(skew).toBeGreaterThanOrEqual(ROLE_SPAWN_DISPATCH_DELAY_MS - 50);
      expect(skew).toBeLessThanOrEqual(ROLE_SPAWN_DISPATCH_DELAY_MS + 5000);
    });

    // Persisted mappings still win after return (post-spawn configure).
    expect(await toolNames(s.run.promoterThreadId!, s.run.plannerThreadId, "Harness promoter", "harness")).toContain("harness_submit_promotion");
  });

  it("failed planner spawn compensates into Cancelled with no orphan mapping", async () => {
    ctx = await loadRace(async () => {
      throw new Error("spawn exploded");
    });
    const { host, inFlight } = ctx;
    await expect(
      host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "fail start" }),
    ).rejects.toThrow(/compensated/);
    // The spawn threw before creating a thread, so no configure ran and no
    // attempt mapping exists; the Setup row was compensated to Cancelled.
    expect(inFlight.length).toBe(0);
    const db = host.bb.storage.database();
    expect((db.prepare("SELECT COUNT(*) AS n FROM harness_v3_attempts").get() as { n: number }).n).toBe(0);
    const cancelled = (await host.harness.behavior.callRpc("v3Status", { threadId: HOME, projectId: PROJECT })) as {
      run: { state: string } | null;
    };
    expect(cancelled.run?.state).toBe("Cancelled");
  });

  it("failed explorer spawn keeps Exploring retryable with no orphan mapping", async () => {
    let failNext = false;
    ctx = await loadRace(async (args, next) => {
      if (failNext) {
        failNext = false;
        throw new Error("spawn exploded");
      }
      return next(args);
    });
    const { host, inFlight } = ctx;
    await host.harness.behavior.callRpc("v3Start", { threadId: HOME, projectId: PROJECT, objective: "fail explorer" });
    failNext = true;
    await expect(
      host.harness.behavior.callRpc("v3RunExplorer", { threadId: HOME, projectId: PROJECT }),
    ).rejects.toThrow(/spawn exploded/);
    // Only the planner spawn ran configure; the failed dispatch recorded nothing.
    expect(inFlight.length).toBe(1);
    let s = await v3Status(host);
    expect(s.run.state).toBe("Exploring");
    expect(s.run.explorerThreadId).toBeNull();
    const db = host.bb.storage.database();
    expect((db.prepare("SELECT COUNT(*) AS n FROM harness_v3_attempts WHERE role = 'explorer'").get() as { n: number }).n).toBe(0);
    // Retry dispatches cleanly with a deferred sendAt.
    await host.harness.behavior.callRpc("v3RunExplorer", { threadId: HOME, projectId: PROJECT });
    s = await v3Status(host);
    expect(s.run.explorerThreadId).toMatch(/thr_race_/);
    expect(inFlight.length).toBe(2);
    expect(inFlight[1]!.tools).toContain("harness_submit_exploration");
  });
});
