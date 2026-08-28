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
  return Object.assign(host, {
    threads,
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

  it("reopens the last Worker when Critic rewinds", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const { planId, critic: liveCritic } = await startThroughCritic(host);
    expect(liveCritic?.status).toBe("in_progress");
    expect(liveCritic?.childThreadId).toMatch(/^thr_child_/);
    const criticChildId = liveCritic!.childThreadId!;

    const rewound = (await host.harness.behavior.callRpc("rewind", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as {
      arc: { phase: string };
      plan: { nodes: PlanNodeView[] };
    };
    expect(rewound.arc.phase).toBe("worker");
    const stopCalls = host.harness.inspection.sdk.callsTo("threads.stop");
    expect(stopCalls.at(-1)).toEqual([{ threadId: criticChildId }]);
    const worker = rewound.plan.nodes.find((node) => node.phase === "worker");
    const critic = rewound.plan.nodes.find((node) => node.phase === "critic");
    expect(worker?.status).toBe("pending");
    expect(worker?.childThreadId).toBeNull();
    expect(critic?.status).toBe("pending");
    expect(critic?.childThreadId).toBe(criticChildId);
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
    expect(done.plan.totals.tokens.total).toBe(17);
  });

  it("does not reopen Worker if stopping the live Critic child fails", async () => {
    host = await loadPlugin({ allowSpawn: true });
    const { planId, critic: liveCritic, worker: doneWorker } = await startThroughCritic(host);
    host.setStopError("child still running");
    const criticChildId = liveCritic!.childThreadId!;
    expect(doneWorker?.status).toBe("done");

    await expect(
      host.harness.behavior.callRpc("rewind", {
        threadId: PARENT,
        projectId: PROJECT,
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
    const first = host.harness.behavior.callRpc("startNode", {
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
    const stale = host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
      projectId: PROJECT,
    });
    releaseSpawn?.();
    await first;
    await stopped;
    await expect(stale).rejects.toThrow(/not the active Harness run|No active Harness run/i);
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
