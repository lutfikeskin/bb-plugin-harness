import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { STANDARD_HARNESS_ID } from "../lib/definitions";
import { MILESTONE_PIPELINE_ID } from "../lib/run-engine";

const PROJECT = "proj_test";
const PARENT = "thr_parent";
const ENV = "env_parent";

async function loadPlugin(options?: { allowSpawn?: boolean; stopError?: string }) {
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
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error(`missing thread ${threadId}`);
          return thread;
        },
        spawn: async (args: Record<string, unknown>) => {
          if (!options?.allowSpawn) {
            throw new Error("standard start must not spawn a child");
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
      run: unknown;
      harness: { id: string; engine: string } | null;
      plan: { id: string; nodes: Array<{ id: string; phase: string }> } | null;
    };
    expect(status.run).toBeNull();
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
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    const db = host.bb.storage.database();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM arcs").get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM harness_runs").get() as { n: number }).n,
    ).toBe(0);
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
    expect(ids.every((id) => id.includes("-explore") || id.includes("-plan") || id.includes("-worker") || id.includes("-critic") || id.includes("-promote"))).toBe(
      true,
    );
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
        harnessSnapshot: { phases: { critic: { detail: string } } } | null;
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
    expect(after.plan?.nodes.find((node) => node.phase === "critic")?.detail).toBe(
      "Be meaner.",
    );
    const listed = (await host.harness.behavior.callRpc("listHarnesses", {})) as {
      harnesses: Array<{ id: string; phases: { critic: { detail: string } } }>;
    };
    expect(
      listed.harnesses.find((item) => item.id === created.harness.id)?.phases.critic
        .detail,
    ).toBe("Be nicer.");
    await host.harness.behavior.callRpc("deleteHarness", { id: created.harness.id });
    const afterDelete = (await host.harness.behavior.callRpc("listHarnesses", {})) as {
      harnesses: Array<{ id: string }>;
    };
    expect(afterDelete.harnesses.map((item) => item.id)).toEqual([
      STANDARD_HARNESS_ID,
      MILESTONE_PIPELINE_ID,
    ]);
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
        id: MILESTONE_PIPELINE_ID,
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it("hides a completed Milestone run after Standard starts on the same thread", async () => {
    host = await loadPlugin({ allowSpawn: true });
    await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Milestone first",
      harnessId: MILESTONE_PIPELINE_ID,
    });
    await host.harness.behavior.callRpc("stopRun", {
      threadId: PARENT,
      projectId: PROJECT,
    });
    const next = (await host.harness.behavior.callRpc("startRun", {
      threadId: PARENT,
      projectId: PROJECT,
      objective: "Standard after Milestone",
    })) as {
      run: { status: string } | null;
      harness: { id: string; engine: string } | null;
      plan: { nodes: Array<{ phase: string }> } | null;
    };
    expect(next.run).toBeNull();
    expect(next.harness).toMatchObject({
      id: STANDARD_HARNESS_ID,
      engine: "manual",
    });
    expect(next.plan?.nodes.map((node) => node.phase)).toContain("explore");
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
    expect(
      after.plan.nodes.find((node) => node.id === `${first.plan.id}-explore`)?.status,
    ).toBe("in_progress");
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

    const reopened = (await host.harness.behavior.callRpc("startNode", {
      planId,
      nodeId: "worker",
      threadId: PARENT,
    })) as { plan: { nodes: PlanNodeView[] } };
    expect(reopened.plan.nodes.find((node) => node.phase === "worker")?.status).toBe(
      "in_progress",
    );
    expect(reopened.plan.nodes.find((node) => node.phase === "critic")?.status).toBe(
      "pending",
    );
  });

  it("does not reopen Worker if stopping the live Critic child fails", async () => {
    host = await loadPlugin({ allowSpawn: true, stopError: "child still running" });
    const { planId, critic: liveCritic, worker: doneWorker } = await startThroughCritic(
      host,
    );
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
