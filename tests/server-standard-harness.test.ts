import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { REMOVED_MILESTONE_PIPELINE_ID, STANDARD_HARNESS_ID } from "../lib/definitions";

const PROJECT = "proj_test";
const PARENT = "thr_parent";
const ENV = "env_parent";

async function loadPlugin(options?: {
  allowSpawn?: boolean;
  stopError?: string;
  mkdirError?: string;
  events?: unknown[];
  spawnGate?: Promise<void>;
  executionOptionsGate?: Promise<void>;
  defaultExecutionOptions?: { model: string } | null;
  childOutput?: string | null;
}) {
  let childSeq = 0;
  let stopError = options?.stopError;
  const threads = new Map([
    [
      PARENT,
      makeThreadResponse({
        id: PARENT,
        projectId: PROJECT,
        environmentId: ENV,
        providerId: "pi",
      }),
    ],
  ]);
  const host = createFakePluginHost({
    pluginId: "harness",
    agentSkillIds: ["harness-arc"],
    sdk: {
      environments: {
        get: async () => ({
          id: ENV,
          hostId: "host_1",
          path: "/tmp/ws",
        }),
      },
      files: {
        mkdir: async () => {
          if (options?.mkdirError) throw new Error(options.mkdirError);
          return { path: "/tmp/ws/artifacts" };
        },
        write: async () => ({ outcome: "written" }),
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error(`missing thread ${threadId}`);
          return thread;
        },
        defaultExecutionOptions: async () => {
          if (options?.executionOptionsGate) await options.executionOptionsGate;
          return options?.defaultExecutionOptions ?? null;
        },
        output: async () => ({
          output: options && "childOutput" in options
            ? options.childOutput ?? null
            : "Test child output.",
        }),
        send: async () => ({ ok: true, delivery: "sent" as const }),
        spawn: async (args: Record<string, unknown>) => {
          if (!options?.allowSpawn) {
            throw new Error("this start must not spawn a child");
          }
          if (options.spawnGate) await options.spawnGate;
          childSeq += 1;
          const child = makeThreadResponse({
            id: `thr_child_${childSeq}`,
            projectId: PROJECT,
            environmentId: ENV,
            parentThreadId: String(args.parentThreadId),
          });
          threads.set(child.id, child);
          return child;
        },
        stop: async ({ threadId }: { threadId: string }) => {
          if (stopError) throw new Error(stopError);
          return threads.get(threadId);
        },
        events: {
          list: async () => options?.events ?? [],
        },
      },
    },
  });
  await plugin(host.bb);
  const rawCallRpc = host.harness.behavior.callRpc.bind(host.harness.behavior);
  // Legacy cases in this suite focus on lifecycle mechanics. Supply the v0.2
  // optimistic-concurrency envelope here; dedicated tests below exercise stale
  // revisions and empty-output rejection against rawCallRpc.
  (host.harness.behavior as { callRpc: typeof host.harness.behavior.callRpc }).callRpc = (async (
    method: string,
    input: Record<string, unknown>,
  ) => {
    const next = { ...input };
    const mutationMethods = new Set([
      "startNode", "completeNode", "skipNode", "reopenNode", "resetCriticBlock", "stopRun", "setPhase",
      "addNode", "setNodeRouting",
    ]);
    if (mutationMethods.has(method)) {
      let plan: { revision: number; nodes: Array<{ id: string; phase: string; attempt: { id: string } | null }> } | null = null;
      if (typeof next.planId === "string") {
        const result = (await rawCallRpc("getPlan", {
          id: next.planId,
          threadId: next.threadId ?? PARENT,
          projectId: next.projectId ?? PROJECT,
        })) as { plan: typeof plan };
        plan = result.plan;
      } else if (typeof next.threadId === "string") {
        const result = (await rawCallRpc("getStatus", {
          threadId: next.threadId,
          projectId: next.projectId ?? PROJECT,
        })) as { plan: typeof plan };
        plan = result.plan;
      }
      next.expectedRevision ??= plan?.revision ?? 0;
      next.requestId ??= `test:${method}:${Math.random()}`;
      if (method === "stopRun") next.reason ??= "Test cancellation.";
      if (method === "setPhase") next.reason ??= "Test phase recovery.";
      if (method === "skipNode" || method === "resetCriticBlock") next.reason ??= "Test mutation.";
      if (method === "reopenNode") {
        next.reason ??= "Test recovery.";
        next.recovery = true;
      }
      if (method === "completeNode" && plan && typeof next.nodeId === "string") {
        const node = plan.nodes.find((item) => item.id === next.nodeId || item.phase === next.nodeId);
        next.expectedAttemptId ??= node?.attempt?.id ?? null;
        if (node && node.phase !== "critic" && node.attempt && !next.summary && !next.artifactPaths) {
          next.summary = "Test child output.";
        }
      }
    }
    const result = await rawCallRpc(method as never, next as never);
    if (method === "startNode" && typeof next.planId === "string") {
      try {
        const after = (await rawCallRpc("getPlan", {
          id: next.planId,
          threadId: (next.threadId as string) ?? PARENT,
          projectId: (next.projectId as string) ?? PROJECT,
        })) as { plan: { nodes: Array<{ id: string; phase: string; execution: string; status: string }> } | null };
        const startedId = String(next.nodeId ?? "");
        const startedNode = after.plan?.nodes.find((n) => n.id === startedId || n.phase === startedId);
        if (startedNode && startedNode.execution === "parent" && startedNode.status === "in_progress") {
          await host.harness.behavior.emitThreadEvent("thread.idle", {
            thread: threads.get((next.threadId as string) ?? PARENT) as never,
            lastAssistantText: `Parent ${startedNode.phase} output`,
          });
          await new Promise((resolve) => setImmediate(resolve));
        }
      } catch {}
    }
    return result;
  }) as typeof host.harness.behavior.callRpc;
  return Object.assign(host, {
    threads,
    rawCallRpc,
    setStopError(value: string | undefined) {
      stopError = value;
    },
  });
}

type PlanNodeView = {
  id: string;
  phase: string;
  status: string;
  childThreadId: string | null;
  execution?: string;
};

async function startThroughCritic(pluginHost: FakePluginHost) {
  const started = (await pluginHost.harness.behavior.callRpc("startRun", {
    threadId: PARENT,
    projectId: PROJECT,
    objective: "Rewind path",
  })) as { plan: { id: string; nodes: PlanNodeView[] } };
  const planId = started.plan.id;
  for (const alias of ["explore", "plan", "worker"]) {
    await pluginHost.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: alias,
      threadId: PARENT,
    });
    if (alias === "explore" || alias === "plan") {
      await (pluginHost as unknown as { threads: Map<string, unknown> }).threads.get(PARENT);
      await pluginHost.harness.behavior.emitThreadEvent("thread.idle", {
        thread: (pluginHost as unknown as { threads: Map<string, unknown> }).threads.get(PARENT) as never,
        lastAssistantText: `Done ${alias}`,
      });
      // let idle handler settle
      await new Promise((resolve) => setImmediate(resolve));
    }
    await pluginHost.harness.behavior.callRpc("completeNode", {
      planId,
      nodeId: alias,
      projectId: PROJECT,
      threadId: PARENT,
    });
  }
  await pluginHost.harness.behavior.callRpc("setPhase", {
    threadId: PARENT,
    projectId: PROJECT,
    phase: "critic",
  });
  const afterCritic = (await pluginHost.harness.behavior.callRpc("startNode", {
    planId,
    nodeId: "critic",
    threadId: PARENT,
  })) as { plan: { nodes: PlanNodeView[] } };
  const critic = afterCritic.plan.nodes.find((node) => node.phase === "critic");
  const worker = afterCritic.plan.nodes.find((node) => node.phase === "worker");
  return { planId, critic, worker };
}

async function startThroughPlan(pluginHost: FakePluginHost) {
  const started = (await pluginHost.harness.behavior.callRpc("startRun", {
    threadId: PARENT,
    projectId: PROJECT,
    objective: "Gated child",
  })) as { plan: { id: string } };
  const planId = started.plan.id;
  for (const alias of ["explore", "plan"]) {
    await pluginHost.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: alias,
      threadId: PARENT,
      projectId: PROJECT,
    });
    await pluginHost.harness.behavior.emitThreadEvent("thread.idle", {
      thread: (pluginHost as unknown as { threads: Map<string, unknown> }).threads.get(PARENT) as never,
      lastAssistantText: `Done ${alias}`,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await pluginHost.harness.behavior.callRpc("completeNode", {
      planId,
      nodeId: alias,
      projectId: PROJECT,
      threadId: PARENT,
    });
  }
  return planId;
}

async function waitForNodeStatus(
  pluginHost: FakePluginHost,
  planId: string,
  phase: string,
  status: string,
) {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    const peek = (await pluginHost.harness.behavior.callRpc("getPlan", {
      id: planId,
      projectId: PROJECT,
      threadId: PARENT,
    })) as { plan: { nodes: Array<{ phase: string; status: string }> } };
    if (peek.plan.nodes.find((node) => node.phase === phase)?.status === status) return;
  }
  throw new Error(`timed out waiting for ${phase} to be ${status}`);
}

function seedLegacyThreadPlan(
  db: ReturnType<FakePluginHost["bb"]["storage"]["database"]>,
  args: { id: string; name: string; updatedAt: number; workerChildId: string | null },
) {
  db.prepare(
    `INSERT INTO plans (id, project_id, thread_id, name, created_at, updated_at, harness_id, harness_snapshot, correction_count, critic_blocked)
     VALUES (?, ?, ?, ?, ?, ?, 'standard', NULL, 0, 0)`,
  ).run(args.id, PROJECT, PARENT, args.name, args.updatedAt, args.updatedAt);
  for (const [index, phase] of ["explore", "plan", "worker", "critic", "promote"].entries()) {
    db.prepare(
      `INSERT INTO plan_nodes (id, plan_id, title, detail, phase, status, deps, sort_order, child_thread_id, execution, skills)
       VALUES (?, ?, ?, '', ?, ?, '[]', ?, ?, 'child', '[]')`,
    ).run(
      `${args.id}-${phase}`,
      args.id,
      phase,
      phase,
      phase === "worker" && args.workerChildId ? "in_progress" : "pending",
      index,
      phase === "worker" ? args.workerChildId : null,
    );
  }
}

describe("standard and custom harnesses", () => {
  let host: (FakePluginHost & {
    threads: Map<string, unknown>;
    setStopError: (value: string | undefined) => void;
  }) | undefined;
  afterEach(async () => {
    await host?.harness.lifecycle.dispose();
    host = undefined;
  });

  it("defaults startRun to Standard Harness without spawning a child", async () => {
    host = await loadPlugin();
    const status = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Use the default Harness",
    })) as {
      harness: { id: string; engine: string } | null;
      plan: { id: string; nodes: Array<{ id: string; phase: string; execution: string }> } | null;
    };
    expect(status.harness).toMatchObject({
      id: STANDARD_HARNESS_ID,
      engine: "manual",
    });
    expect(status.plan?.nodes.map((node) => node.phase)).toEqual([
      "explore",
      "plan",
      "worker",
      "critic",
      "promote",
    ]);
    expect(status.plan?.nodes.find((node) => node.phase === "explore")?.execution).toBe("parent");
    expect(status.plan?.nodes.find((node) => node.phase === "worker")?.execution).toBe("child");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    const db = host.bb.storage.database();
    expect((db.prepare("SELECT COUNT(*) AS n FROM arcs").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM harness_runs").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='harness_runs'").get() as { name: string } | undefined)?.name).toBe(
      "harness_runs",
    );
  });

  it("refuses starting the removed Milestone id", async () => {
    host = await loadPlugin();
    await expect(
      host.harness.behavior.callRpc("startRun", {
        threadId: PARENT,
        projectId: PROJECT,
        objective: "Old id",
        harnessId: REMOVED_MILESTONE_PIPELINE_ID,
      }),
    ).rejects.toThrow(/removed/i);
    const listed = (await host.harness.behavior.callRpc("listHarnesses", {})) as {
      harnesses: Array<{ id: string }>;
    };
    expect(listed.harnesses.map((item) => item.id)).toEqual([STANDARD_HARNESS_ID]);
  });

  it("uses unique seeded node ids across plans", async () => {
    host = await loadPlugin();
    await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "First",
    });
    const other = makeThreadResponse({
      id: "thr_other",
      projectId: PROJECT,
      environmentId: ENV,
    });
    host.threads.set("thr_other", other);
    const second = (await host.harness.behavior.callRpc("startRun", {
      threadId: "thr_other",
      projectId: PROJECT,
      objective: "Second",
    })) as { plan: { id: string; nodes: Array<{ id: string }> } | null };
    const first = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { plan: { id: string; nodes: Array<{ id: string }> } | null };
    const ids = [
      ...(first.plan?.nodes.map((node) => node.id) ?? []),
      ...(second.plan?.nodes.map((node) => node.id) ?? []),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("snapshots custom instructions at start", async () => {
    host = await loadPlugin();
    const created = (await host.harness.behavior.callRpc("createHarness", {
      name: "Stern critic",
      phases: { critic: { detail: "Be meaner." } },
    })) as { harness: { id: string } };
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Custom snapshot",
      harnessId: created.harness.id,
    })) as {
      plan: {
        nodes: Array<{ phase: string; detail: string }>;
        harnessSnapshot: { phases: { critic: { detail: string } }; schemaVersion: number } | null;
      } | null;
    };
    await host.harness.behavior.callRpc("updateHarness", {
      id: created.harness.id,
      name: "Stern critic",
      phases: { critic: { detail: "Be nicer." } },
    });
    const after = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as {
      plan: {
        nodes: Array<{ phase: string; detail: string }>;
        harnessSnapshot: { phases: { critic: { detail: string } } } | null;
      } | null;
    };
    expect(started.plan?.harnessSnapshot?.phases.critic.detail).toBe("Be meaner.");
    expect(started.plan?.harnessSnapshot?.schemaVersion).toBe(2);
    expect(after.plan?.nodes.find((node) => node.phase === "critic")?.detail).toBe("Be meaner.");
  });

  it("rejects mutating built-ins", async () => {
    host = await loadPlugin();
    await expect(
      host.harness.behavior.callRpc("updateHarness", {
        id: STANDARD_HARNESS_ID,
        name: "Nope",
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      host.harness.behavior.callRpc("deleteHarness", {
        id: REMOVED_MILESTONE_PIPELINE_ID,
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it("fails required artifact start before activating when the workspace is unavailable", async () => {
    host = await loadPlugin({ mkdirError: "no workspace" });
    const created = (await host.harness.behavior.callRpc("createHarness", {
      name: "Required artifacts",
      artifactPolicy: "required",
    })) as { harness: { id: string } };
    await expect(
      host.harness.behavior.callRpc("startRun", {
        threadId: PARENT,
        projectId: PROJECT,
        objective: "Need artifacts",
        harnessId: created.harness.id,
      }),
    ).rejects.toThrow(/unavailable/i);
    const db = host.bb.storage.database();
    expect((db.prepare("SELECT COUNT(*) AS n FROM arcs").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n).toBe(0);
  });

  it("seeds skipped Promote when promoteMode is off", async () => {
    host = await loadPlugin();
    const created = (await host.harness.behavior.callRpc("createHarness", {
      name: "No promote",
      promoteMode: "off",
    })) as { harness: { id: string } };
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Skip promote",
      harnessId: created.harness.id,
    })) as { plan: { nodes: Array<{ phase: string; status: string }> } };
    expect(started.plan.nodes.find((node) => node.phase === "promote")?.status).toBe("skipped");
  });

  it("namespaces added node ids globally and resolves phase aliases", async () => {
    host = await loadPlugin();
    const first = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "One",
    })) as { plan: { id: string; nodes: Array<{ id: string; status: string }> } };
    const other = makeThreadResponse({
      id: "thr_two",
      projectId: PROJECT,
      environmentId: ENV,
    });
    host.threads.set("thr_two", other);
    const second = (await host.harness.behavior.callRpc("startRun", {
      threadId: "thr_two",
      projectId: PROJECT,
      objective: "Two",
    })) as { plan: { id: string } };
    const added = (await host.harness.behavior.callRpc("addNode", {
      planId: first.plan.id,
      title: "Extra worker",
      phase: "worker",
      deps: ["plan"],
      projectId: PROJECT,
      threadId: PARENT,
    })) as { plan: { nodes: Array<{ id: string; deps: string[] }> } };
    const extra = added.plan.nodes.find((node) => node.id.includes("extra-worker"));
    expect(extra?.id.startsWith(`${first.plan.id}-`)).toBe(true);
    expect(extra?.deps).toEqual([`${first.plan.id}-plan`]);
    await expect(
      host.harness.behavior.callRpc("addNode", {
        planId: second.plan.id,
        title: "Broken",
        deps: ["missing-node"],
        projectId: PROJECT,
        threadId: "thr_two",
      }),
    ).rejects.toThrow(/unknown dependency/i);
    await host.harness.behavior.callRpc("startNode", {
      planId: first.plan.id,
      nodeId: "explore",
      threadId: PARENT,
    });
    const after = (await host.harness.behavior.callRpc("getPlan", {
      id: first.plan.id,
      projectId: PROJECT,
      threadId: PARENT,
    })) as { plan: { nodes: Array<{ id: string; status: string }> } };
    expect(after.plan.nodes.find((node) => node.id === `${first.plan.id}-explore`)?.status).toBe(
      "in_progress",
    );
    await host.harness.behavior.callRpc("completeNode", {
      planId: first.plan.id,
      nodeId: "explore",
      projectId: PROJECT,
      threadId: PARENT,
    });
    await expect(
      host.harness.behavior.callRpc("completeNode", {
        planId: first.plan.id,
        nodeId: "plan",
        projectId: PROJECT,
        threadId: PARENT,
      }),
    ).rejects.toThrow(/in progress/i);
  });

  it("disables generic Critic rewind without mutating Worker or child state", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const { planId, critic: liveCritic } = await startThroughCritic(host);
    const criticChildId = liveCritic!.childThreadId!;
    const stopsBefore = host.harness.inspection.sdk.callsTo("threads.stop").length;

    await expect(
      host.harness.behavior.callRpc("rewind", {
        threadId: PARENT,
        projectId: PROJECT,
      }),
    ).rejects.toThrow(/normal rewind is disabled/i);

    const current = (await host.harness.behavior.callRpc("getPlan", {
      id: planId, threadId: PARENT, projectId: PROJECT,
    })) as { plan: { nodes: PlanNodeView[] } };
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(stopsBefore);
    expect(current.plan.nodes.find((node) => node.phase === "worker")?.status).toBe("done");
    expect(current.plan.nodes.find((node) => node.phase === "critic")).toMatchObject({
      status: "in_progress", childThreadId: criticChildId,
    });
  });

  it("records Critic REWORK atomically and enforces maxCorrections", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const created = (await host.harness.behavior.callRpc("createHarness", {
      name: "One correction",
      maxCorrections: 1,
    })) as { harness: { id: string } };
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Limited rework",
      harnessId: created.harness.id,
    })) as { plan: { id: string } };
    const planId = started.plan.id;
    for (const alias of ["explore", "plan", "worker"]) {
      await host.harness.behavior.callRpc("startNode", {
        planId,
        nodeId: alias,
        threadId: PARENT,
      });
      await host.harness.behavior.callRpc("completeNode", { planId, nodeId: alias, projectId: PROJECT, threadId: PARENT });
    }
    await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "critic",
      threadId: PARENT,
    });
    const reworked = (await host.harness.behavior.callRpc("completeNode", {
      planId,
      nodeId: "critic",
      verdict: "REWORK",
      summary: "Needs a tighter test.",

      projectId: PROJECT,
      threadId: PARENT,})) as {
      plan: {
        correctionCount: number;
        nodes: Array<{ phase: string; status: string; result: { verdict: string } | null }>;
      };
    };
    expect(reworked.plan.correctionCount).toBe(1);
    expect(reworked.plan.nodes.find((node) => node.phase === "worker")?.status).toBe("pending");
    expect(reworked.plan.nodes.find((node) => node.phase === "critic")?.result?.verdict).toBe(
      "REWORK",
    );

    for (const alias of ["worker"]) {
      await host.harness.behavior.callRpc("startNode", {
        planId,
        nodeId: alias,
        threadId: PARENT,
      });
      await host.harness.behavior.callRpc("completeNode", { planId, nodeId: alias, projectId: PROJECT, threadId: PARENT });
    }
    await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "critic",
      threadId: PARENT,
    });
    await expect(
      host.harness.behavior.callRpc("completeNode", {
        planId,
        nodeId: "critic",
        verdict: "REWORK",
        summary: "Again",

      projectId: PROJECT,
      threadId: PARENT,}),
    ).rejects.toThrow(/correction limit/i);
  });

  it("blocks Promote after Critic BLOCK until reset", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const { planId } = await startThroughCritic(host);
    const blocked = (await host.harness.behavior.callRpc("completeNode", {
      planId,
      nodeId: "critic",
      verdict: "BLOCK",
      summary: "Unsafe to ship.",

      projectId: PROJECT,
      threadId: PARENT,})) as { plan: { criticBlocked: boolean } };
    expect(blocked.plan.criticBlocked).toBe(true);
    await expect(
      host.harness.behavior.callRpc("startNode", {
        planId,
        nodeId: "promote",
        threadId: PARENT,
      }),
    ).rejects.toThrow(/blocked/i);
    await host.harness.behavior.callRpc("resetCriticBlock", { planId, projectId: PROJECT, threadId: PARENT });
    const started = (await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "promote",
      threadId: PARENT,
    })) as { plan: { nodes: Array<{ phase: string; status: string }> } };
    expect(started.plan.nodes.find((node) => node.phase === "promote")?.status).toBe("in_progress");
  });

  it("stores child token counters from thread/tokenUsage/updated events", async () => {
    host = await loadPlugin({
      allowSpawn: true,
      events: [
        {
          type: "thread/tokenUsage/updated",
          tokenUsage: {
            total: {
              inputTokens: 11,
              cachedInputTokens: 1,
              outputTokens: 5,
              reasoningOutputTokens: 0,
              totalTokens: 17,
            },
          },
        },
      ],
    });
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Tokens",
    })) as { plan: { id: string } };
    await host.harness.behavior.callRpc("startNode", {
      planId: started.plan.id,
      nodeId: "explore",
      threadId: PARENT,
    });
    await host.harness.behavior.callRpc("completeNode", {
      planId: started.plan.id,
      nodeId: "explore",

      projectId: PROJECT,
      threadId: PARENT,});
    await host.harness.behavior.callRpc("startNode", {
      planId: started.plan.id,
      nodeId: "plan",
      threadId: PARENT,
    });
    await host.harness.behavior.callRpc("completeNode", {
      planId: started.plan.id,
      nodeId: "plan",

      projectId: PROJECT,
      threadId: PARENT,});
    await host.harness.behavior.callRpc("startNode", {
      planId: started.plan.id,
      nodeId: "worker",
      threadId: PARENT,
    });
    const done = (await host.harness.behavior.callRpc("completeNode", {
      planId: started.plan.id,
      nodeId: "worker",

      projectId: PROJECT,
      threadId: PARENT,})) as {
      plan: {
        totals: { tokens: { total: number | null } };
        nodes: Array<{ phase: string; attempt: { tokens: { total: number | null } } | null }>;
      };
    };
    expect(done.plan.nodes.find((node) => node.phase === "worker")?.attempt?.tokens.total).toBe(17);
    // Parent Explore and Plan now have tracked attempts; each records the same tokenUsage event.
    expect(done.plan.totals.tokens.total).toBe(51);
  });

  it("rejects stale revisions before a transition can mutate DAG state", async () => {
    host = await loadPlugin();
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT, projectId: PROJECT, objective: "Stale guard",
    })) as { plan: { id: string; revision: number } };
    await (host as any).rawCallRpc("startNode", {
      planId: started.plan.id, nodeId: "explore", threadId: PARENT, projectId: PROJECT,
      expectedRevision: started.plan.revision, requestId: "fresh-start",
    });
    await expect(
      (host as any).rawCallRpc("startNode", {
        planId: started.plan.id, nodeId: "plan", threadId: PARENT, projectId: PROJECT,
        expectedRevision: started.plan.revision, requestId: "stale-start",
      }),
    ).rejects.toThrow(/stale Harness state/i);
  });

  it("rejects empty child completion and binds accepted output to its attempt", async () => {
    host = await loadPlugin({ allowSpawn: true, childOutput: null });
    const planId = await startThroughPlan(host);
    const started = (await host.harness.behavior.callRpc("startNode", {
      planId, nodeId: "worker", threadId: PARENT, projectId: PROJECT,
    })) as { plan: { revision: number; nodes: Array<{ phase: string; attempt: { id: string } | null }> } };
    const attemptId = started.plan.nodes.find((node) => node.phase === "worker")!.attempt!.id;
    await expect(
      (host as any).rawCallRpc("completeNode", {
        planId, nodeId: "worker", threadId: PARENT, projectId: PROJECT,
        summary: "Operator summary cannot replace missing child output.",
        expectedRevision: started.plan.revision, expectedAttemptId: attemptId,
        requestId: "empty-output",
      }),
    ).rejects.toThrow(/child output is empty/i);

    await host.harness.lifecycle.dispose();
    host = undefined;
    host = await loadPlugin({ allowSpawn: true, childOutput: "Implemented and verified." });
    const acceptedPlanId = await startThroughPlan(host);
    const acceptedStart = (await host.harness.behavior.callRpc("startNode", {
      planId: acceptedPlanId, nodeId: "worker", threadId: PARENT, projectId: PROJECT,
    })) as { plan: { revision: number; nodes: Array<{ phase: string; childThreadId: string | null; attempt: { id: string } | null }> } };
    const acceptedWorker = acceptedStart.plan.nodes.find((node) => node.phase === "worker")!;
    const acceptedAttemptId = acceptedWorker.attempt!.id;
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: host.threads.get(acceptedWorker.childThreadId!) as never,
      lastAssistantText: "Implemented and verified.",
    });
    const afterIdle = (await host.harness.behavior.callRpc("getPlan", {
      id: acceptedPlanId, threadId: PARENT, projectId: PROJECT,
    })) as { plan: { nodes: Array<{ phase: string; attempt: { outcome: string; outputHash: string | null } | null }> } };
    expect(afterIdle.plan.nodes.find((node) => node.phase === "worker")?.attempt).toMatchObject({
      outcome: "idle_with_output",
      outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const completed = (await (host as any).rawCallRpc("completeNode", {
      planId: acceptedPlanId, nodeId: "worker", threadId: PARENT, projectId: PROJECT,
      summary: "Implemented and verified the requested node.",
      expectedRevision: acceptedStart.plan.revision, expectedAttemptId: acceptedAttemptId,
      requestId: "accepted-output",
    })) as { plan: { nodes: Array<{ phase: string; result: { attemptId: string; requestId: string; outputHash: string } | null; attempt: { outcome: string; outputHash: string | null } | null }> } };
    const worker = completed.plan.nodes.find((node) => node.phase === "worker")!;
    expect(worker.result).toMatchObject({ attemptId: acceptedAttemptId, requestId: "accepted-output" });
    expect(worker.result?.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(worker.attempt).toMatchObject({ outcome: "idle_with_output", outputHash: worker.result?.outputHash });

    const db = host.bb.storage.database();
    const mutation = db.prepare(
      "SELECT action, request_id, attempt_id, output_hash FROM plan_mutations WHERE plan_id = ? AND request_id = ?",
    ).get(acceptedPlanId, "accepted-output") as Record<string, unknown>;
    expect(mutation).toMatchObject({
      action: "node.complete", request_id: "accepted-output", attempt_id: acceptedAttemptId,
      output_hash: worker.result?.outputHash,
    });
  });

  it("does not apply REWORK if stopping the live Critic child fails", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const { planId, critic: liveCritic, worker: doneWorker } = await startThroughCritic(host);
    host.setStopError("child still running");
    const criticChildId = liveCritic!.childThreadId!;
    expect(doneWorker?.status).toBe("done");

    await expect(
      host.harness.behavior.callRpc("completeNode", {
        planId, nodeId: "critic", verdict: "REWORK", summary: "Needs correction.",
        threadId: PARENT, projectId: PROJECT,
      }),
    ).rejects.toThrow(/failed to stop child/);
    expect(host.harness.inspection.sdk.callsTo("threads.stop").at(-1)).toEqual([
      { threadId: criticChildId },
    ]);

    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { arc: { phase: string }; plan: { nodes: PlanNodeView[] } };
    expect(status.arc.phase).toBe("critic");
    const worker = status.plan.nodes.find((node) => node.phase === "worker");
    const critic = status.plan.nodes.find((node) => node.phase === "critic");
    expect(worker?.status).toBe("done");
    expect(critic?.status).toBe("in_progress");
    expect(critic?.childThreadId).toBe(criticChildId);
    await expect(
      host.harness.behavior.callRpc("startNode", {
        planId,
        nodeId: "worker",
        threadId: PARENT,
      }),
    ).rejects.toThrow(/cannot start|already in progress/i);
  });

  it("rejects a caller projectId that does not match the thread", async () => {
    host = await loadPlugin();
    await expect(
      host.harness.behavior.callRpc("getStatus", {
        threadId: PARENT,
        projectId: "proj_other",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("rejects cross-project and cross-thread plan reads and mutations", async () => {
    host = await loadPlugin();
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Owned",
    })) as { plan: { id: string } };
    const planId = started.plan.id;
    host.threads.set(
      "thr_other",
      makeThreadResponse({ id: "thr_other", projectId: PROJECT, environmentId: ENV }),
    );
    await expect(
      host.harness.behavior.callRpc("getPlan", {
        id: planId,
        projectId: "proj_other",
        threadId: PARENT,
      }),
    ).rejects.toThrow(/does not match thread/);
    await expect(
      host.harness.behavior.callRpc("completeNode", {
        planId,
        nodeId: "explore",
        projectId: PROJECT,
        threadId: "thr_other",
      }),
    ).rejects.toThrow(/does not belong/);
  });

  it("rejects Critic-child completion and REWORK stop failure leaves authority unchanged", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const { planId, critic } = await startThroughCritic(host);
    host.setStopError("child still running");
    const childId = critic!.childThreadId!;
    await expect(
      host.harness.behavior.callAgentTool(
        "harness_complete_node",
        {
          planId,
          nodeId: "critic",
          verdict: "REWORK",
          summary: "from child",
        },
        { threadId: childId, projectId: PROJECT },
      ),
    ).rejects.toThrow(/parent operator/i);
    await expect(
      host.harness.behavior.callRpc("completeNode", {
        planId,
        nodeId: "critic",
        verdict: "REWORK",
        summary: "Needs a tighter test.",
        projectId: PROJECT,
        threadId: PARENT,
      }),
    ).rejects.toThrow(/failed to stop child/);
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as {
      plan: {
        correctionCount: number;
        nodes: Array<{
          phase: string;
          status: string;
          result: { verdict: string } | null;
        }>;
      };
    };
    expect(status.plan.correctionCount).toBe(0);
    expect(status.plan.nodes.find((node) => node.phase === "worker")?.status).toBe("done");
    expect(status.plan.nodes.find((node) => node.phase === "critic")?.status).toBe("in_progress");
    expect(status.plan.nodes.find((node) => node.phase === "critic")?.result).toBeNull();
  });

  it("stops children before skip or stop mutation and keeps state on stop failure", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Live child",
    })) as { plan: { id: string } };
    const planId = started.plan.id;
    for (const alias of ["explore", "plan"]) {
      await host.harness.behavior.callRpc("startNode", {
        planId,
        nodeId: alias,
        threadId: PARENT,
        projectId: PROJECT,
      });
      await host.harness.behavior.callRpc("completeNode", {
        planId,
        nodeId: alias,
        projectId: PROJECT,
        threadId: PARENT,
      });
    }
    await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    });
    host.setStopError("child still running");
    await expect(
      host.harness.behavior.callRpc("skipNode", {
        planId,
        nodeId: "worker",
        projectId: PROJECT,
        threadId: PARENT,
      }),
    ).rejects.toThrow(/failed to stop child/);
    await expect(
      host.harness.behavior.callRpc("stopRun", {
        threadId: PARENT,
        projectId: PROJECT,
      }),
    ).rejects.toThrow(/failed to stop child/);
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { harness: { id: string } | null; plan: { nodes: PlanNodeView[] } };
    expect(status.harness?.id).toBe("standard");
    expect(status.plan.nodes.find((node) => node.phase === "worker")?.status).toBe("in_progress");
    await expect(
      host.harness.behavior.callRpc("startNode", {
        planId,
        nodeId: "critic",
        threadId: PARENT,
        projectId: PROJECT,
      }),
    ).rejects.toThrow(/already in progress/i);
  });

  it("reconciles a failed child so the node can start again without dropping attempts", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Retry",
    })) as { plan: { id: string } };
    const planId = started.plan.id;
    for (const alias of ["explore", "plan"]) {
      await host.harness.behavior.callRpc("startNode", {
        planId,
        nodeId: alias,
        threadId: PARENT,
        projectId: PROJECT,
      });
      await host.harness.behavior.callRpc("completeNode", {
        planId,
        nodeId: alias,
        projectId: PROJECT,
        threadId: PARENT,
      });
    }
    const live = (await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    })) as { plan: { nodes: Array<{ phase: string; childThreadId: string | null; attempts: unknown[] }> } };
    const worker = live.plan.nodes.find((node) => node.phase === "worker");
    const child = host.threads.get(worker!.childThreadId!) as ReturnType<typeof makeThreadResponse>;
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: child,
      error: "child crashed",
    });
    const after = (await host.harness.behavior.callRpc("getPlan", {
      id: planId,
      projectId: PROJECT,
      threadId: PARENT,
    })) as {
      plan: {
        nodes: Array<{
          phase: string;
          status: string;
          childThreadId: string | null;
          attempts: unknown[];
        }>;
      };
    };
    const pending = after.plan.nodes.find((node) => node.phase === "worker");
    expect(pending?.status).toBe("pending");
    expect(pending?.childThreadId).toBeNull();
    expect(pending?.attempts.length).toBe(1);
    const restarted = (await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    })) as { plan: { nodes: Array<{ phase: string; status: string; attempts: unknown[] }> } };
    const again = restarted.plan.nodes.find((node) => node.phase === "worker");
    expect(again?.status).toBe("in_progress");
    expect(again?.attempts.length).toBe(2);
  });

  it("does not let historical Milestone rows block Standard start", async () => {
    host = await loadPlugin();
    const db = host.bb.storage.database();
    db.prepare(
      `INSERT INTO harness_runs (
         id, project_id, parent_thread_id, template_id, status, task_packet_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'running', '{}', 1, 1)`,
    ).run("run_old", PROJECT, PARENT, "milestone-pipeline");
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "After milestone",
    })) as { harness: { id: string } | null; plan: { id: string } | null };
    expect(started.harness?.id).toBe("standard");
    expect(started.plan).not.toBeNull();
    expect(
      (db.prepare("SELECT status FROM harness_runs WHERE id = 'run_old'").get() as { status: string }).status,
    ).toBe("cancelled");
  });

  it("rejects legacy --milestone instead of starting Standard", async () => {
    host = await loadPlugin();
    const result = await host.harness.behavior.runCli(
      ["start", "--task", "Ship it", "--milestone"],
      { threadId: PARENT, projectId: PROJECT },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/removed/i);
    const db = host.bb.storage.database();
    expect((db.prepare("SELECT COUNT(*) AS n FROM arcs").get() as { n: number }).n).toBe(0);
  });

  it("uses an explicit CLI --thread as authority instead of stale CLI project context", async () => {
    host = await loadPlugin();
    await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT, projectId: PROJECT, objective: "Explicit CLI thread",
    });
    const result = await host.harness.behavior.runCli(
      ["status", "--thread", PARENT, "--json"],
      { threadId: "thr_stale_context", projectId: "proj_stale_context" },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "{}").plan).toMatchObject({ lifecycle: "active" });
  });

  it("gives parent-execution nodes frozen custom detail and injects only harness-arc", async () => {
    host = await loadPlugin();
    const created = (await host.harness.behavior.callRpc("createHarness", {
      name: "Parent worker",
      promoteMode: "ask",
      phases: {
        worker: { title: "Parent ship", detail: "Ship from the parent.", execution: "parent", skills: ["review"] },
      },
    })) as { harness: { promoteMode: string; phases: { worker: { skills: string[]; execution: string } } } };
    expect(created.harness.promoteMode).toBe("always");
    expect(created.harness.phases.worker.skills).toEqual([]);
    expect(created.harness.phases.worker.execution).toBe("parent");
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Parent policy",
      harnessId: created.harness.id,
    })) as { plan: { id: string } };
    for (const alias of ["explore", "plan"]) {
      await host.harness.behavior.callRpc("startNode", {
        planId: started.plan.id,
        nodeId: alias,
        threadId: PARENT,
        projectId: PROJECT,
      });
      await host.harness.behavior.callRpc("completeNode", {
        planId: started.plan.id,
        nodeId: alias,
        projectId: PROJECT,
        threadId: PARENT,
      });
    }
    await host.harness.behavior.callRpc("startNode", {
      planId: started.plan.id,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    });
    const config = await host.harness.behavior.resolveAgentConfiguration({
      thread: {
        id: PARENT,
        title: "parent",
        parentThreadId: null,
        sourceThreadId: null,
      },
      project: {
        id: PROJECT,
        kind: "standard",
        name: "test",
        gitRemoteUrl: null,
      },
      environment: {
        id: ENV,
        name: null,
        path: "/tmp/ws",
        workspaceProvisionType: "unmanaged",
        branchName: null,
      },
      host: { id: "host_1", name: "host" },
      provider: {
        id: "pi",
        model: "inherited-model",
        capabilities: { supportsNativeUserQuestion: false },
      },
      origin: { kind: null, pluginId: null },
    });
    const instructionText = [
      config.instructions,
      ...config.tools.map((tool) => ("instructions" in tool ? tool.instructions : "")),
    ]
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item ?? "")))
      .join("\n");
    expect(instructionText).toMatch(/Ship from the parent/);
    expect(config.skills).toEqual(["harness-arc"]);
    expect(config.tools.map((tool) => tool.name)).toContain("harness_complete_node");
  });

  it("claims Start with a single arc under concurrent callers", async () => {
    host = await loadPlugin();
    const results = await Promise.allSettled([
      host.harness.behavior.callRpc("startRun", {
        threadId: PARENT,
        projectId: PROJECT,
        objective: "First",
      }),
      host.harness.behavior.callRpc("startRun", {
        threadId: PARENT,
        projectId: PROJECT,
        objective: "Second",
      }),
    ]);
    expect(results.filter((item) => item.status === "fulfilled").length).toBe(1);
    expect(results.filter((item) => item.status === "rejected").length).toBe(1);
    const db = host.bb.storage.database();
    expect((db.prepare("SELECT COUNT(*) AS n FROM arcs").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n).toBe(1);
  });

  it("rejects unsafe artifact refs and records inherited model plus stored-row token history", async () => {
    host = await loadPlugin({
      allowSpawn: true,
      // Force the inherit path: clear seeded worker defaults for this test.
      // (setRouting covered by the new defaults test below.)
      events: [
        {
          type: "thread/tokenUsage/updated",
          data: {
            tokenUsage: {
              total: {
                inputTokens: 3,
                cachedInputTokens: 0,
                outputTokens: 1,
                reasoningOutputTokens: 0,
                totalTokens: 4,
              },
            },
          },
        },
      ],
    });
    // Force the inherit path for worker: clear seeded defaults for this test.
    await host.harness.behavior.callRpc("setRouting", { slot: "workerFirst", choice: null });
    await host.harness.behavior.callRpc("setRouting", { slot: "workerRest", choice: null });
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Telemetry",
    })) as { plan: { id: string } };
    const planId = started.plan.id;
    await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "explore",
      threadId: PARENT,
      projectId: PROJECT,
    });
    await expect(
      host.harness.behavior.callRpc("completeNode", {
        planId,
        nodeId: "explore",
        projectId: PROJECT,
        threadId: PARENT,
        artifactPaths: ["../secret.md"],
      }),
    ).rejects.toThrow(/artifacts\//);
    await host.harness.behavior.callRpc("completeNode", {
      planId,
      nodeId: "explore",
      projectId: PROJECT,
      threadId: PARENT,
    });
    await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "plan",
      threadId: PARENT,
      projectId: PROJECT,
    });
    await host.harness.behavior.callRpc("completeNode", {
      planId,
      nodeId: "plan",
      projectId: PROJECT,
      threadId: PARENT,
    });
    const live = (await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    })) as {
      plan: {
        nodes: Array<{
          phase: string;
          attempt: { model: string | null; providerId: string | null; source: string } | null;
        }>;
      };
    };
    expect(live.plan.nodes.find((node) => node.phase === "worker")?.attempt).toMatchObject({
      providerId: null,
      model: null,
      source: "inherited-unknown",
    });
    const done = (await host.harness.behavior.callRpc("completeNode", {
      planId,
      nodeId: "worker",
      projectId: PROJECT,
      threadId: PARENT,
      artifactPaths: ["artifacts/harness/note.md"],
    })) as {
      plan: {
        nodes: Array<{
          phase: string;
          attempts: Array<{ tokens: { total: number | null } }>;
        }>;
      };
    };
    expect(done.plan.nodes.find((node) => node.phase === "worker")?.attempts[0]?.tokens.total).toBe(4);
  });

  it("spawns only one child when Start races after a pending claim", async () => {
    let releaseSpawn: (() => void) | undefined;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    host = await loadPlugin({ allowSpawn: true, spawnGate });
    const planId = await startThroughPlan(host);
    const first = host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    });
    await waitForNodeStatus(host, planId, "worker", "starting");
    const secondPromise = host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    releaseSpawn?.();
    await first;
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    const second = (await secondPromise) as {
      plan: { nodes: Array<{ phase: string; status: string }> };
    };
    expect(second.plan.nodes.find((node) => node.phase === "worker")?.status).toBe("in_progress");
    const after = (await host.harness.behavior.callRpc("getPlan", {
      id: planId,
      projectId: PROJECT,
      threadId: PARENT,
    })) as { plan: { nodes: Array<{ phase: string; status: string; childThreadId: string | null }> } };
    expect(after.plan.nodes.find((node) => node.phase === "worker")).toMatchObject({
      status: "in_progress",
      childThreadId: "thr_child_1",
    });
  });

  it("seeds role defaults and reflects them as node effective routing", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const routing = (await host.harness.behavior.callRpc("getRouting", {})) as {
      routing: Record<string, { providerId: string; model: string; reasoningLevel: string } | null>;
    };
    expect(routing.routing.explore).toMatchObject({ providerId: "acp-devin", model: "swe-1-7-medium" });
    expect(routing.routing.plan).toMatchObject({ providerId: "pi", model: "openai-codex/gpt-5.6-sol" });
    expect(routing.routing.workerFirst).toMatchObject({ providerId: "pi", model: "opencode/muse-spark-1.3-contributor-free" });
    expect(routing.routing.workerRest).toMatchObject({ providerId: "pi", model: "opencode/muse-spark-1.3-contributor-free" });
    expect(routing.routing.critic).toMatchObject({ providerId: "pi", model: "openai-codex/gpt-5.6-sol" });
    expect(routing.routing.promote).toMatchObject({ providerId: "acp-cursor", model: "grok-4.6" });
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT, projectId: PROJECT, objective: "Defaults reflected",
    })) as { plan: { id: string } };
    // Override worker node on the right side before it starts.
    const planBefore = (await host.harness.behavior.callRpc("getPlan", {
      id: started.plan.id, threadId: PARENT, projectId: PROJECT,
    })) as { plan: { revision: number; nodes: Array<{ id: string; phase: string }> } };
    const worker = planBefore.plan.nodes.find((n) => n.phase === "worker")!;
    const overridden = (await (host as any).rawCallRpc("setNodeRouting", {
      planId: started.plan.id, nodeId: worker.id, threadId: PARENT, projectId: PROJECT,
      choice: { providerId: "pi", model: "openai-codex/gpt-5.6-sol", reasoningLevel: "high" },
      expectedRevision: planBefore.plan.revision, requestId: "test-override",
    })) as { plan: { nodes: Array<{ id: string; providerId: string | null; model: string | null }> } };
    expect(overridden.plan.nodes.find((n) => n.id === worker.id)).toMatchObject({
      providerId: "pi", model: "openai-codex/gpt-5.6-sol",
    });
  });

  it("sets and shows role routing through the CLI with catalog validation", async () => {
    host = await loadPlugin();
    const bad = await host.harness.behavior.runCli(
      ["routing", "set", "workerFirst", "nope", "no-model"],
      {},
    );
    expect(bad.exitCode).toBe(1);
    const shown = await host.harness.behavior.runCli(["routing", "show"], {});
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toMatch(/explore:/);
  });

  it("resolves inherited routing before spawn and skips the attached child after", async () => {
    let releaseOptions: (() => void) | undefined;
    let releaseSpawn: (() => void) | undefined;
    const executionOptionsGate = new Promise<void>((resolve) => {
      releaseOptions = resolve;
    });
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    host = await loadPlugin({ allowSpawn: true, spawnGate, executionOptionsGate });
    // Force the inherit path: clear seeded worker defaults so spawn waits on the gate.
    await host.harness.behavior.callRpc("setRouting", { slot: "workerFirst", choice: null });
    await host.harness.behavior.callRpc("setRouting", { slot: "workerRest", choice: null });
    const planId = await startThroughPlan(host);
    const first = host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    });
    await waitForNodeStatus(host, planId, "worker", "starting");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    const before = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { harness: { id: string } | null; plan: { nodes: Array<{ phase: string; status: string }> } };
    expect(before.harness?.id).toBe("standard");
    expect(before.plan.nodes.find((node) => node.phase === "worker")?.status).toBe("starting");
    releaseOptions?.();
    await waitForNodeStatus(host, planId, "worker", "starting");
    for (let i = 0; i < 50 && host.harness.inspection.sdk.callsTo("threads.spawn").length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    releaseSpawn?.();
    await first;
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    const attached = (await host.harness.behavior.callRpc("getPlan", {
      id: planId,
      projectId: PROJECT,
      threadId: PARENT,
    })) as { plan: { nodes: Array<{ phase: string; status: string; childThreadId: string | null }> } };
    expect(attached.plan.nodes.find((node) => node.phase === "worker")).toMatchObject({
      status: "in_progress",
      childThreadId: "thr_child_1",
    });
    await host.harness.behavior.callRpc("skipNode", {
      planId,
      nodeId: "worker",
      projectId: PROJECT,
      threadId: PARENT,
    });
    const skipped = (await host.harness.behavior.callRpc("getPlan", {
      id: planId,
      projectId: PROJECT,
      threadId: PARENT,
    })) as { plan: { nodes: Array<{ phase: string; status: string }> } };
    expect(skipped.plan.nodes.find((node) => node.phase === "worker")?.status).toBe("skipped");
  });

  it("stops the spawned child when attach CAS misses", async () => {
    let releaseSpawn: (() => void) | undefined;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    host = await loadPlugin({ allowSpawn: true, spawnGate });
    const planId = await startThroughPlan(host);
    const first = host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    });
    await waitForNodeStatus(host, planId, "worker", "starting");
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE plan_nodes SET status = 'pending' WHERE plan_id = ? AND status = 'starting'",
    ).run(planId);
    releaseSpawn?.();
    await expect(first).rejects.toThrow(/claim was lost/i);
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toEqual([
      [{ threadId: "thr_child_1" }],
    ]);
    const after = (await host.harness.behavior.callRpc("getPlan", {
      id: planId,
      projectId: PROJECT,
      threadId: PARENT,
    })) as {
      plan: {
        nodes: Array<{
          phase: string;
          status: string;
          childThreadId: string | null;
          attempts: unknown[];
        }>;
      };
    };
    const worker = after.plan.nodes.find((node) => node.phase === "worker");
    expect(worker).toMatchObject({
      status: "pending",
      childThreadId: null,
    });
    expect(worker?.attempts).toEqual([]);
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { harness: { id: string } | null };
    expect(status.harness?.id).toBe("standard");
  });

  it("rejects a gated Start after Stop settles the arc, twice", async () => {
    host = await loadPlugin({ allowSpawn: true });
    for (let cycle = 0; cycle < 2; cycle++) {
      const planId = await startThroughPlan(host);
      await host.harness.behavior.callRpc("stopRun", {
        threadId: PARENT,
        projectId: PROJECT,
      });
      const detached = (await host.harness.behavior.callRpc("getPlan", {
        id: planId,
        projectId: PROJECT,
        threadId: PARENT,
      })) as { plan: { nodes: Array<{ phase: string; status: string }> } | null };
      expect(detached.plan).not.toBeNull();
      await expect(
        host.harness.behavior.callRpc("startNode", {
          planId,
          nodeId: "worker",
          threadId: PARENT,
          projectId: PROJECT,
        }),
      ).rejects.toThrow(/not the active Harness run|No active Harness run/i);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
      const status = (await host.harness.behavior.callRpc("getStatus", {
        threadId: PARENT,
        projectId: PROJECT,
      })) as { harness: { id: string } | null };
      expect(status.harness).toBeNull();
    }
  });

  it("stops the attached child when Start holds the lock then Stop runs", async () => {
    for (let cycle = 0; cycle < 2; cycle++) {
      let releaseSpawn: (() => void) | undefined;
      const spawnGate = new Promise<void>((resolve) => {
        releaseSpawn = resolve;
      });
      host = await loadPlugin({ allowSpawn: true, spawnGate });
      const planId = await startThroughPlan(host);
      const started = host.harness.behavior.callRpc("startNode", {
        planId,
        nodeId: "worker",
        threadId: PARENT,
        projectId: PROJECT,
      });
      await waitForNodeStatus(host, planId, "worker", "starting");
      const stopped = host.harness.behavior.callRpc("stopRun", {
        threadId: PARENT,
        projectId: PROJECT,
      });
      releaseSpawn?.();
      await started;
      await stopped;
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
      expect(host.harness.inspection.sdk.callsTo("threads.stop")).toEqual([
        [{ threadId: "thr_child_1" }],
      ]);
      const after = (await host.harness.behavior.callRpc("getPlan", {
        id: planId,
        projectId: PROJECT,
        threadId: PARENT,
      })) as {
        plan: { nodes: Array<{ phase: string; status: string; childThreadId: string | null }> };
      };
      expect(after.plan.nodes.find((node) => node.phase === "worker")).toMatchObject({
        status: "skipped",
        childThreadId: "thr_child_1",
      });
      const status = (await host.harness.behavior.callRpc("getStatus", {
        threadId: PARENT,
        projectId: PROJECT,
      })) as { harness: { id: string } | null };
      expect(status.harness).toBeNull();
      await host?.harness.lifecycle.dispose();
      host = undefined;
    }
  });

  it("rejects a queued Start after Stop without a second spawn", async () => {
    let releaseSpawn: (() => void) | undefined;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    host = await loadPlugin({ allowSpawn: true, spawnGate });
    const planId = await startThroughPlan(host);
    const before = (await host.harness.behavior.callRpc("getPlan", {
      id: planId, threadId: PARENT, projectId: PROJECT,
    })) as { plan: { revision: number } };
    const first = (host as any).rawCallRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
      expectedRevision: before.plan.revision,
      requestId: "queued-first",
    });
    await waitForNodeStatus(host, planId, "worker", "starting");
    const claimed = (await host.harness.behavior.callRpc("getPlan", {
      id: planId, threadId: PARENT, projectId: PROJECT,
    })) as { plan: { revision: number } };
    const stopped = (host as any).rawCallRpc("stopRun", {
      threadId: PARENT,
      projectId: PROJECT,
      expectedRevision: claimed.plan.revision,
      requestId: "queued-stop",
      reason: "Concurrency test.",
    });
    const stale = (host as any).rawCallRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
      expectedRevision: claimed.plan.revision,
      requestId: "queued-stale",
    });
    releaseSpawn?.();
    await first;
    await stopped;
    await expect(stale).rejects.toThrow(/not the active Harness run|No active Harness run|Stale Harness state/i);
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toEqual([
      [{ threadId: "thr_child_1" }],
    ]);
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { harness: { id: string } | null };
    expect(status.harness).toBeNull();
  });

  it("keeps status and Stop on plan A after creating plan B on the same thread", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const planId = await startThroughPlan(host);
    const live = (await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    })) as { plan: { nodes: Array<{ phase: string; childThreadId: string | null }> } };
    const childId = live.plan.nodes.find((node) => node.phase === "worker")!.childThreadId!;
    const created = (await host.harness.behavior.callRpc("createPlan", {
      projectId: PROJECT,
      threadId: PARENT,
      name: "Detached B",
    })) as { plan: { id: string } };
    expect(created.plan.id).not.toBe(planId);
    await host.harness.behavior.callRpc("addNode", {
      planId: created.plan.id,
      title: "Extra worker",
      threadId: PARENT,
      projectId: PROJECT,
    });
    const listed = (await host.harness.behavior.callRpc("listPlans", {
      projectId: PROJECT,
      threadId: PARENT,
    })) as { plans: Array<{ id: string }> };
    expect(listed.plans.map((plan) => plan.id)).toEqual(
      expect.arrayContaining([planId, created.plan.id]),
    );
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as {
      harness: { id: string } | null;
      plan: { id: string; nodes: Array<{ phase: string; status: string; childThreadId: string | null }> } | null;
    };
    expect(status.harness?.id).toBe("standard");
    expect(status.plan?.id).toBe(planId);
    expect(status.plan?.nodes.find((node) => node.phase === "worker")).toMatchObject({
      status: "in_progress",
      childThreadId: childId,
    });
    const db = host.bb.storage.database();
    expect(
      (db.prepare("SELECT plan_id FROM arcs WHERE thread_id = ?").get(PARENT) as { plan_id: string }).plan_id,
    ).toBe(planId);
    await host.harness.behavior.callRpc("stopRun", {
      threadId: PARENT,
      projectId: PROJECT,
    });
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: childId }]]);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM arcs WHERE thread_id = ?").get(PARENT) as { n: number }).n,
    ).toBe(0);
    const detached = (await host.harness.behavior.callRpc("getPlan", {
      id: created.plan.id,
      projectId: PROJECT,
      threadId: PARENT,
    })) as { plan: { id: string } | null };
    expect(detached.plan?.id).toBe(created.plan.id);
    const afterStop = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { harness: { id: string } | null };
    expect(afterStop.harness).toBeNull();
  });

  it("migrates arcs.plan_id and resolves legacy null bindings conservatively", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const db = host.bb.storage.database();
    const columns = db.prepare("PRAGMA table_info(arcs)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "plan_id")).toBe(true);

    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Bound on start",
    })) as { plan: { id: string } };
    expect(
      (db.prepare("SELECT plan_id FROM arcs WHERE thread_id = ?").get(PARENT) as { plan_id: string }).plan_id,
    ).toBe(started.plan.id);

    await host.harness.lifecycle.dispose();
    host = await loadPlugin({ allowSpawn: true });
    const legacy = host.bb.storage.database();
    legacy.prepare("DELETE FROM arcs").run();
    legacy.prepare("DELETE FROM plan_node_attempts").run();
    legacy.prepare("DELETE FROM plan_nodes").run();
    legacy.prepare("DELETE FROM plans").run();
    const now = Date.now();
    legacy
      .prepare(
        `INSERT INTO plans (id, project_id, thread_id, name, created_at, updated_at, harness_id, harness_snapshot, correction_count, critic_blocked)
         VALUES (?, ?, ?, ?, ?, ?, 'standard', NULL, 0, 0)`,
      )
      .run("plan_only", PROJECT, PARENT, "Only plan", now, now);
    legacy
      .prepare(
        `INSERT INTO arcs (thread_id, project_id, phase, note, updated_at, harness_id, plan_id)
         VALUES (?, ?, 'explore', '', ?, 'standard', NULL)`,
      )
      .run(PARENT, PROJECT, now);
    const bound = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { plan: { id: string } | null };
    expect(bound.plan?.id).toBe("plan_only");
    expect(
      (legacy.prepare("SELECT plan_id FROM arcs WHERE thread_id = ?").get(PARENT) as { plan_id: string | null })
        .plan_id,
    ).toBe("plan_only");

    await host.harness.lifecycle.dispose();
    host = await loadPlugin({ allowSpawn: true });
    const ambiguous = host.bb.storage.database();
    ambiguous.prepare("DELETE FROM arcs").run();
    ambiguous.prepare("DELETE FROM plan_node_attempts").run();
    ambiguous.prepare("DELETE FROM plan_nodes").run();
    ambiguous.prepare("DELETE FROM plans").run();
    const stamp = Date.now();
    for (const row of [
      { id: "plan_a", name: "A", updated: stamp, child: "thr_legacy_child" },
      { id: "plan_b", name: "B", updated: stamp + 10, child: null as string | null },
    ]) {
      ambiguous
        .prepare(
          `INSERT INTO plans (id, project_id, thread_id, name, created_at, updated_at, harness_id, harness_snapshot, correction_count, critic_blocked)
           VALUES (?, ?, ?, ?, ?, ?, 'standard', NULL, 0, 0)`,
        )
        .run(row.id, PROJECT, PARENT, row.name, stamp, row.updated);
      for (const [index, phase] of ["explore", "plan", "worker", "critic", "promote"].entries()) {
        ambiguous
          .prepare(
            `INSERT INTO plan_nodes (id, plan_id, title, detail, phase, status, deps, sort_order, child_thread_id, execution, skills)
             VALUES (?, ?, ?, '', ?, ?, '[]', ?, ?, 'child', '[]')`,
          )
          .run(
            `${row.id}-${phase}`,
            row.id,
            phase,
            phase,
            phase === "worker" && row.child ? "in_progress" : "pending",
            index,
            row.child && phase === "worker" ? row.child : null,
          );
      }
    }
    ambiguous
      .prepare(
        `INSERT INTO arcs (thread_id, project_id, phase, note, updated_at, harness_id, plan_id)
         VALUES (?, ?, 'worker', '', ?, 'standard', NULL)`,
      )
      .run(PARENT, PROJECT, stamp);
    host.threads.set(
      "thr_legacy_child",
      makeThreadResponse({
        id: "thr_legacy_child",
        projectId: PROJECT,
        environmentId: ENV,
        parentThreadId: PARENT,
      }),
    );
    const kept = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { plan: { id: string } | null };
    expect(kept.plan?.id).toBe("plan_a");
    expect(
      (ambiguous.prepare("SELECT plan_id FROM arcs WHERE thread_id = ?").get(PARENT) as { plan_id: string | null })
        .plan_id,
    ).toBeNull();
    await host.harness.behavior.callRpc("stopRun", {
      threadId: PARENT,
      projectId: PROJECT,
    });
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toEqual([
      [{ threadId: "thr_legacy_child" }],
    ]);
    expect(
      (ambiguous.prepare("SELECT COUNT(*) AS n FROM arcs").get() as { n: number }).n,
    ).toBe(0);
  });

  it("stops every live legacy child when plan_id is ambiguous then deletes the arc", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const db = host.bb.storage.database();
    db.prepare("DELETE FROM arcs").run();
    db.prepare("DELETE FROM plan_node_attempts").run();
    db.prepare("DELETE FROM plan_nodes").run();
    db.prepare("DELETE FROM plans").run();
    const stamp = Date.now();
    seedLegacyThreadPlan(db, {
      id: "plan_a",
      name: "A",
      updatedAt: stamp,
      workerChildId: "thr_legacy_a",
    });
    seedLegacyThreadPlan(db, {
      id: "plan_b",
      name: "B",
      updatedAt: stamp + 10,
      workerChildId: "thr_legacy_b",
    });
    seedLegacyThreadPlan(db, {
      id: "plan_c",
      name: "C pending",
      updatedAt: stamp + 20,
      workerChildId: null,
    });
    db.prepare(
      `INSERT INTO arcs (thread_id, project_id, phase, note, updated_at, harness_id, plan_id)
       VALUES (?, ?, 'worker', '', ?, 'standard', NULL)`,
    ).run(PARENT, PROJECT, stamp);
    for (const id of ["thr_legacy_a", "thr_legacy_b"]) {
      host.threads.set(
        id,
        makeThreadResponse({
          id,
          projectId: PROJECT,
          environmentId: ENV,
          parentThreadId: PARENT,
        }),
      );
    }
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { plan: { id: string } | null };
    expect(status.plan).toBeNull();
    expect(
      (db.prepare("SELECT plan_id FROM arcs WHERE thread_id = ?").get(PARENT) as { plan_id: string | null })
        .plan_id,
    ).toBeNull();
    await host.harness.behavior.callRpc("stopRun", {
      threadId: PARENT,
      projectId: PROJECT,
    });
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toEqual([
      [{ threadId: "thr_legacy_a" }],
      [{ threadId: "thr_legacy_b" }],
    ]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM arcs").get() as { n: number }).n).toBe(0);
    const statuses = db
      .prepare(
        `SELECT id, status FROM plan_nodes WHERE phase = 'worker' ORDER BY id`,
      )
      .all() as Array<{ id: string; status: string }>;
    expect(statuses).toEqual([
      { id: "plan_a-worker", status: "skipped" },
      { id: "plan_b-worker", status: "skipped" },
      { id: "plan_c-worker", status: "pending" },
    ]);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM plan_nodes WHERE status IN ('in_progress', 'starting')`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("keeps the legacy arc when an ambiguous Stop cannot stop a live child", async () => {
    host = await loadPlugin({ allowSpawn: true, stopError: "child still running" });
    const db = host.bb.storage.database();
    db.prepare("DELETE FROM arcs").run();
    db.prepare("DELETE FROM plan_node_attempts").run();
    db.prepare("DELETE FROM plan_nodes").run();
    db.prepare("DELETE FROM plans").run();
    const stamp = Date.now();
    seedLegacyThreadPlan(db, {
      id: "plan_a",
      name: "A",
      updatedAt: stamp,
      workerChildId: "thr_legacy_a",
    });
    seedLegacyThreadPlan(db, {
      id: "plan_b",
      name: "B",
      updatedAt: stamp + 10,
      workerChildId: "thr_legacy_b",
    });
    db.prepare(
      `INSERT INTO arcs (thread_id, project_id, phase, note, updated_at, harness_id, plan_id)
       VALUES (?, ?, 'worker', '', ?, 'standard', NULL)`,
    ).run(PARENT, PROJECT, stamp);
    for (const id of ["thr_legacy_a", "thr_legacy_b"]) {
      host.threads.set(
        id,
        makeThreadResponse({
          id,
          projectId: PROJECT,
          environmentId: ENV,
          parentThreadId: PARENT,
        }),
      );
    }
    await expect(
      host.harness.behavior.callRpc("stopRun", {
        threadId: PARENT,
        projectId: PROJECT,
      }),
    ).rejects.toThrow(/failed to stop child thr_legacy_a/i);
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toEqual([
      [{ threadId: "thr_legacy_a" }],
    ]);
    expect(
      (db.prepare("SELECT plan_id FROM arcs WHERE thread_id = ?").get(PARENT) as { plan_id: string | null })
        .plan_id,
    ).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM arcs").get() as { n: number }).n).toBe(1);
    const statuses = db
      .prepare(
        `SELECT id, status FROM plan_nodes WHERE phase = 'worker' ORDER BY id`,
      )
      .all() as Array<{ id: string; status: string }>;
    expect(statuses).toEqual([
      { id: "plan_a-worker", status: "in_progress" },
      { id: "plan_b-worker", status: "in_progress" },
    ]);
  });

  it("does not let a failed-child event overwrite a completed node", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Complete then fail",
    })) as { plan: { id: string } };
    const planId = started.plan.id;
    for (const alias of ["explore", "plan"]) {
      await host.harness.behavior.callRpc("startNode", {
        planId,
        nodeId: alias,
        threadId: PARENT,
        projectId: PROJECT,
      });
      await host.harness.behavior.callRpc("completeNode", {
        planId,
        nodeId: alias,
        projectId: PROJECT,
        threadId: PARENT,
      });
    }
    const live = (await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    })) as { plan: { nodes: Array<{ phase: string; childThreadId: string | null }> } };
    const childId = live.plan.nodes.find((node) => node.phase === "worker")!.childThreadId!;
    await host.harness.behavior.callRpc("completeNode", {
      planId,
      nodeId: "worker",
      projectId: PROJECT,
      threadId: PARENT,
    });
    const child = host.threads.get(childId) as ReturnType<typeof makeThreadResponse>;
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: child,
      error: "late failure",
    });
    const after = (await host.harness.behavior.callRpc("getPlan", {
      id: planId,
      projectId: PROJECT,
      threadId: PARENT,
    })) as {
      plan: {
        nodes: Array<{ phase: string; status: string; childThreadId: string | null }>;
      };
    };
    expect(after.plan.nodes.find((node) => node.phase === "worker")).toMatchObject({
      status: "done",
      childThreadId: childId,
    });
  });

  it("does not let a failed-child event overwrite a stopped node", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const started = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Stop then fail",
    })) as { plan: { id: string } };
    const planId = started.plan.id;
    for (const alias of ["explore", "plan"]) {
      await host.harness.behavior.callRpc("startNode", {
        planId,
        nodeId: alias,
        threadId: PARENT,
        projectId: PROJECT,
      });
      await host.harness.behavior.callRpc("completeNode", {
        planId,
        nodeId: alias,
        projectId: PROJECT,
        threadId: PARENT,
      });
    }
    const live = (await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    })) as { plan: { nodes: Array<{ phase: string; childThreadId: string | null }> } };
    const childId = live.plan.nodes.find((node) => node.phase === "worker")!.childThreadId!;
    await host.harness.behavior.callRpc("stopRun", {
      threadId: PARENT,
      projectId: PROJECT,
    });
    const child = host.threads.get(childId) as ReturnType<typeof makeThreadResponse>;
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: child,
      error: "late failure after stop",
    });
    const after = (await host.harness.behavior.callRpc("getPlan", {
      id: planId,
      projectId: PROJECT,
      threadId: PARENT,
    })) as {
      plan: {
        nodes: Array<{ phase: string; status: string; childThreadId: string | null }>;
      };
    };
    expect(after.plan.nodes.find((node) => node.phase === "worker")).toMatchObject({
      status: "skipped",
      childThreadId: childId,
    });
  });
});
