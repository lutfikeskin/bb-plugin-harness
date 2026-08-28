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
}) {
  let childSeq = 0;
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
        spawn: async (args: Record<string, unknown>) => {
          if (!options?.allowSpawn) {
            throw new Error("this start must not spawn a child");
          }
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
          if (options?.stopError) throw new Error(options.stopError);
          return threads.get(threadId);
        },
        events: {
          list: async () => options?.events ?? [],
        },
      },
    },
  });
  await plugin(host.bb);
  return Object.assign(host, { threads });
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

describe("standard and custom harnesses", () => {
  let host: (FakePluginHost & { threads: Map<string, unknown> }) | undefined;
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
    })) as { plan: { nodes: Array<{ id: string; deps: string[] }> } };
    const extra = added.plan.nodes.find((node) => node.id.includes("extra-worker"));
    expect(extra?.id.startsWith(`${first.plan.id}-`)).toBe(true);
    expect(extra?.deps).toEqual([`${first.plan.id}-plan`]);
    await expect(
      host.harness.behavior.callRpc("addNode", {
        planId: second.plan.id,
        title: "Broken",
        deps: ["missing-node"],
      }),
    ).rejects.toThrow(/unknown dependency/i);
    await host.harness.behavior.callRpc("startNode", {
      planId: first.plan.id,
      nodeId: "explore",
      threadId: PARENT,
    });
    const after = (await host.harness.behavior.callRpc("getPlan", {
      id: first.plan.id,
    })) as { plan: { nodes: Array<{ id: string; status: string }> } };
    expect(after.plan.nodes.find((node) => node.id === `${first.plan.id}-explore`)?.status).toBe(
      "in_progress",
    );
    await host.harness.behavior.callRpc("completeNode", {
      planId: first.plan.id,
      nodeId: "explore",
    });
    await expect(
      host.harness.behavior.callRpc("completeNode", {
        planId: first.plan.id,
        nodeId: "plan",
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
    expect(stopCalls).toEqual([[{ threadId: criticChildId }]]);
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
      await host.harness.behavior.callRpc("completeNode", { planId, nodeId: alias });
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
    })) as {
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
      await host.harness.behavior.callRpc("completeNode", { planId, nodeId: alias });
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
      }),
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
    })) as { plan: { criticBlocked: boolean } };
    expect(blocked.plan.criticBlocked).toBe(true);
    await expect(
      host.harness.behavior.callRpc("startNode", {
        planId,
        nodeId: "promote",
        threadId: PARENT,
      }),
    ).rejects.toThrow(/blocked/i);
    await host.harness.behavior.callRpc("resetCriticBlock", { planId });
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
    });
    await host.harness.behavior.callRpc("startNode", {
      planId: started.plan.id,
      nodeId: "plan",
      threadId: PARENT,
    });
    await host.harness.behavior.callRpc("completeNode", {
      planId: started.plan.id,
      nodeId: "plan",
    });
    await host.harness.behavior.callRpc("startNode", {
      planId: started.plan.id,
      nodeId: "worker",
      threadId: PARENT,
    });
    const done = (await host.harness.behavior.callRpc("completeNode", {
      planId: started.plan.id,
      nodeId: "worker",
    })) as {
      plan: {
        totals: { tokens: { total: number | null } };
        nodes: Array<{ phase: string; attempt: { tokens: { total: number | null } } | null }>;
      };
    };
    expect(done.plan.nodes.find((node) => node.phase === "worker")?.attempt?.tokens.total).toBe(17);
    expect(done.plan.totals.tokens.total).toBe(17);
  });

  it("does not reopen Worker if stopping the live Critic child fails", async () => {
    host = await loadPlugin({ allowSpawn: true, stopError: "child still running" });
    const { planId, critic: liveCritic, worker: doneWorker } = await startThroughCritic(host);
    const criticChildId = liveCritic!.childThreadId!;
    expect(doneWorker?.status).toBe("done");

    await expect(
      host.harness.behavior.callRpc("rewind", {
        threadId: PARENT,
        projectId: PROJECT,
      }),
    ).rejects.toThrow(/failed to stop Critic child/);
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toEqual([
      [{ threadId: criticChildId }],
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
});
