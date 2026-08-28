import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import plugin from "../server";
import { MILESTONE_PIPELINE_ID } from "../lib/run-engine";

const PROJECT = "proj_test";
const PARENT = "thr_parent";
const ENV = "env_parent";

function configContext(
  threadId: string,
  extra: Partial<PluginAgentConfigurationContext["thread"]> = {},
): PluginAgentConfigurationContext {
  return {
    thread: {
      id: threadId,
      title: "t",
      parentThreadId: extra.parentThreadId ?? null,
      sourceThreadId: extra.sourceThreadId ?? null,
    },
    project: { id: PROJECT, kind: "standard", name: "Test", gitRemoteUrl: null },
    environment: {
      id: ENV,
      name: "env",
      path: "/tmp/ws",
      workspaceProvisionType: "unmanaged",
      branchName: "main",
    },
    host: { id: "host", name: "host" },
    provider: {
      id: "pi",
      model: "test-model",
      capabilities: { supportsNativeUserQuestion: false },
    },
    origin: { kind: null, pluginId: null },
  };
}

async function loadPlugin(options?: {
  spawnImpl?: (args: Record<string, unknown>) => unknown;
  failSpawn?: boolean;
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
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (thread) return thread;
          const created = makeThreadResponse({
            id: threadId,
            projectId: PROJECT,
            environmentId: ENV,
          });
          threads.set(threadId, created);
          return created;
        },
        spawn: async (args: Record<string, unknown>) => {
          if (options?.failSpawn) throw new Error("spawn failed");
          if (options?.spawnImpl) return options.spawnImpl(args);
          childSeq += 1;
          const child = makeThreadResponse({
            id: `thr_child_${childSeq}`,
            projectId: PROJECT,
            environmentId: ENV,
            parentThreadId: String(args.parentThreadId),
            providerId: typeof args.providerId === "string" ? args.providerId : "pi",
            title: typeof args.title === "string" ? args.title : "child",
          });
          threads.set(child.id, child);
          return child;
        },
        stop: async ({ threadId }: { threadId: string }) => threads.get(threadId),
      },
    },
  });
  await plugin(host.bb);
  return Object.assign(host, { threads });
}

async function startDefault(host: FakePluginHost, extra: Record<string, unknown> = {}) {
  return host.harness.behavior.callRpc("startRun", {
    threadId: PARENT,
    projectId: PROJECT,
    objective: "Ship the opt-in run engine",
    harnessId: MILESTONE_PIPELINE_ID,
    ...extra,
  }) as Promise<{ run: { id: string; status: string; nodes: Array<Record<string, unknown>> } | null }>;
}

describe("backend run engine", () => {
  let host:
    | (FakePluginHost & { threads: Map<string, ReturnType<typeof makeThreadResponse>> })
    | undefined;
  afterEach(async () => {
    await host?.harness.lifecycle.dispose();
    host = undefined;
  });

  it("keeps an ordinary thread inactive after creation and status read", async () => {
    host = await loadPlugin();
    const created = makeThreadResponse({
      id: "thr_new",
      projectId: PROJECT,
      environmentId: ENV,
    });
    host.threads.set("thr_new", created);
    await host.harness.behavior.emitThreadEvent("thread.created", {
      thread: created,
    });
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: "thr_new",
      projectId: PROJECT,
    })) as { run: unknown };
    expect(status.run).toBeNull();
    const db = host.bb.storage.database();
    expect(db.prepare("SELECT COUNT(*) AS n FROM arcs").get() as { n: number }).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM harness_runs").get() as { n: number }).toEqual({
      n: 0,
    });
    const instructions = host.harness.inspection.registrations.instructionProvider?.({
      threadId: "thr_new",
      projectId: PROJECT,
    });
    expect(instructions).toBeNull();
    const configured = await host.harness.behavior.resolveAgentConfiguration(
      configContext("thr_new"),
    );
    expect(configured.tools.map((tool) => tool.name)).toEqual([]);
  });

  it("requires an explicit start and creates one run whose first stage is Scout", async () => {
    host = await loadPlugin();
    const status = await startDefault(host);
    expect(status.run?.status).toBe("running");
    const scout = status.run?.nodes.find((node) => node.templateNodeKey === "scout");
    expect(scout?.status).toBe("in_progress");
    expect(scout?.childThreadId).toMatch(/^thr_child_/);
    const spawn = host.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0] as {
      parentThreadId: string;
      environment: { type: string; environmentId: string };
      visibility: string;
      origin: string;
    };
    expect(spawn.parentThreadId).toBe(PARENT);
    expect(spawn.environment).toEqual({ type: "reuse", environmentId: ENV });
    expect(spawn.visibility).toBe("visible");
    expect(spawn.origin).toBe("plugin");
  });

  it("rejects a duplicate start", async () => {
    host = await loadPlugin();
    await startDefault(host);
    await expect(startDefault(host)).rejects.toThrow(/already active/i);
  });

  it("starts Planner when Scout is disabled", async () => {
    host = await loadPlugin();
    const status = await startDefault(host, { runScout: false });
    const byKey = Object.fromEntries(
      (status.run?.nodes ?? []).map((node) => [node.templateNodeKey, node.status]),
    );
    expect(byKey.scout).toBe("skipped");
    expect(byKey.planner).toBe("in_progress");
  });

  it("uses selected routing on the spawned child", async () => {
    host = await loadPlugin();
    await host.harness.behavior.callRpc("setRouting", {
      slot: "explore",
      choice: {
        providerId: "acp-cursor",
        model: "grok-4.6",
        reasoningLevel: "medium",
      },
    });
    await startDefault(host);
    const spawn = host.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0] as {
      providerId: string;
      model: string;
      reasoningLevel: string;
    };
    expect(spawn.providerId).toBe("acp-cursor");
    expect(spawn.model).toBe("grok-4.6");
    expect(spawn.reasoningLevel).toBe("medium");
  });

  it("rejects result submission from an unrelated thread", async () => {
    host = await loadPlugin();
    await startDefault(host);
    const result = (await host.harness.behavior.callAgentTool(
      "harness_submit_result",
      {
        role: "scout",
        kind: "scout_findings",
        payload: { summary: "mapped", findings: ["a"] },
      },
      { threadId: "thr_unrelated", projectId: PROJECT },
    )) as { isError?: boolean; content?: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/not a Harness role child/i);
  });

  it("rejects a role/stage packet mismatch", async () => {
    host = await loadPlugin();
    const status = await startDefault(host);
    const childId = status.run?.nodes.find((node) => node.templateNodeKey === "scout")
      ?.childThreadId as string;
    const result = (await host.harness.behavior.callAgentTool(
      "harness_submit_result",
      {
        role: "planner",
        kind: "plan_packet",
        payload: { summary: "plan" },
      },
      { threadId: childId, projectId: PROJECT },
    )) as { isError?: boolean; content?: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/Role mismatch/i);
  });

  it("waits for plan approval, then Worker then Reviewer, and honors verdicts", async () => {
    host = await loadPlugin();
    await startDefault(host, { runScout: false });

    const submit = async (templateKey: string, role: string, kind: string, payload: unknown) => {
      const latest = (await host!.harness.behavior.callRpc("getStatus", {
        threadId: PARENT,
        projectId: PROJECT,
      })) as { run: { nodes: Array<{ templateNodeKey: string; childThreadId: string | null }> } };
      const childId = latest.run.nodes.find((node) => node.templateNodeKey === templateKey)
        ?.childThreadId as string;
      return host!.harness.behavior.callAgentTool(
        "harness_submit_result",
        { role, kind, payload },
        { threadId: childId, projectId: PROJECT },
      );
    };

    await submit("planner", "planner", "plan_packet", { summary: "do work", nodes: [] });
    let status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { run: { status: string; nodes: Array<{ templateNodeKey: string; status: string }> } };
    expect(status.run.status).toBe("awaiting_plan_approval");
    expect(status.run.nodes.find((node) => node.templateNodeKey === "worker")?.status).toBe(
      "pending",
    );

    await host.harness.behavior.callRpc("approvePlan", { threadId: PARENT, projectId: PROJECT });
    await submit("worker", "worker", "work_report", {
      summary: "implemented",
      changedPaths: ["lib/run-engine.ts"],
    });
    status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as typeof status;
    expect(status.run.nodes.find((node) => node.templateNodeKey === "reviewer")?.status).toBe(
      "in_progress",
    );

    await submit("reviewer", "reviewer", "review_verdict", {
      verdict: "CORRECTION_REQUIRED",
      summary: "tests missing",
      correctionRequest: "add backend tests",
    });
    status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as typeof status;
    expect(status.run.status).toBe("awaiting_correction_approval");

    await host.harness.behavior.callRpc("approveCorrection", {
      threadId: PARENT,
      projectId: PROJECT,
    });
    await submit("worker_correction", "worker", "work_report", {
      summary: "tests added",
      changedPaths: ["tests/server-run-engine.test.ts"],
    });
    await submit("reviewer_final", "reviewer", "review_verdict", {
      verdict: "CORRECTION_REQUIRED",
      summary: "still no",
      correctionRequest: "loop",
    });
    status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as typeof status;
    expect(status.run.status).toBe("blocked");
  });

  it("APPROVE proceeds to Promote and completes", async () => {
    host = await loadPlugin();
    await startDefault(host, { runScout: false });
    const submit = async (templateKey: string, role: string, kind: string, payload: unknown) => {
      const latest = (await host!.harness.behavior.callRpc("getStatus", {
        threadId: PARENT,
        projectId: PROJECT,
      })) as { run: { nodes: Array<{ templateNodeKey: string; childThreadId: string | null }> } };
      const childId = latest.run.nodes.find((node) => node.templateNodeKey === templateKey)
        ?.childThreadId as string;
      return host!.harness.behavior.callAgentTool(
        "harness_submit_result",
        { role, kind, payload },
        { threadId: childId, projectId: PROJECT },
      );
    };
    await submit("planner", "planner", "plan_packet", { summary: "plan", nodes: [] });
    await host.harness.behavior.callRpc("approvePlan", { threadId: PARENT, projectId: PROJECT });
    await submit("worker", "worker", "work_report", { summary: "done", changedPaths: [] });
    await submit("reviewer", "reviewer", "review_verdict", {
      verdict: "APPROVE",
      summary: "looks good",
    });
    await submit("promote", "promote", "promote_report", { summary: "shipped" });
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { run: { status: string } };
    expect(status.run.status).toBe("completed");
  });

  it("BLOCKED terminates without Promote", async () => {
    host = await loadPlugin();
    await startDefault(host, { runScout: false });
    const submit = async (templateKey: string, role: string, kind: string, payload: unknown) => {
      const latest = (await host!.harness.behavior.callRpc("getStatus", {
        threadId: PARENT,
        projectId: PROJECT,
      })) as { run: { nodes: Array<{ templateNodeKey: string; childThreadId: string | null }> } };
      const childId = latest.run.nodes.find((node) => node.templateNodeKey === templateKey)
        ?.childThreadId as string;
      return host!.harness.behavior.callAgentTool(
        "harness_submit_result",
        { role, kind, payload },
        { threadId: childId, projectId: PROJECT },
      );
    };
    await submit("planner", "planner", "plan_packet", { summary: "plan", nodes: [] });
    await host.harness.behavior.callRpc("approvePlan", { threadId: PARENT, projectId: PROJECT });
    await submit("worker", "worker", "work_report", { summary: "done", changedPaths: [] });
    await submit("reviewer", "reviewer", "review_verdict", {
      verdict: "BLOCKED",
      summary: "unsafe",
    });
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { run: { status: string; nodes: Array<{ templateNodeKey: string; status: string }> } };
    expect(status.run.status).toBe("blocked");
    expect(status.run.nodes.find((node) => node.templateNodeKey === "promote")?.status).toBe(
      "pending",
    );
  });

  it("stop is terminal and idempotent", async () => {
    host = await loadPlugin();
    await startDefault(host);
    await host.harness.behavior.callRpc("stopRun", { threadId: PARENT, projectId: PROJECT });
    const once = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { run: { status: string } };
    expect(once.run.status).toBe("cancelled");
    await host.harness.behavior.callRpc("stopRun", { threadId: PARENT, projectId: PROJECT });
    const twice = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { run: { status: string } };
    expect(twice.run.status).toBe("cancelled");
    await expect(startDefault(host)).resolves.toBeTruthy();
  });

  it("compensates a spawn failure without starting the next stage", async () => {
    host = await loadPlugin({ failSpawn: true });
    await expect(startDefault(host)).rejects.toThrow(/spawn failed/);
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { run: { status: string; nodes: Array<{ templateNodeKey: string; status: string }> } };
    expect(status.run.status).toBe("running");
    expect(status.run.nodes.find((node) => node.templateNodeKey === "scout")?.status).toBe(
      "failed",
    );
    expect(status.run.nodes.find((node) => node.templateNodeKey === "planner")?.status).toBe(
      "pending",
    );
  });

  it("fails a child that errors and offers Retry without starting the next node", async () => {
    host = await loadPlugin();
    const started = await startDefault(host);
    const scout = started.run?.nodes.find((node) => node.templateNodeKey === "scout") as {
      id: string;
      childThreadId: string;
    };
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({
        id: scout.childThreadId,
        projectId: PROJECT,
        environmentId: ENV,
        parentThreadId: PARENT,
        status: "error",
      }),
      error: "provider exited",
    });
    const failed = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as {
      run: {
        status: string;
        controls: { canRetry: boolean };
        nodes: Array<{ templateNodeKey: string; status: string }>;
      };
    };
    expect(failed.run.status).toBe("running");
    expect(failed.run.controls.canRetry).toBe(true);
    expect(failed.run.nodes.find((node) => node.templateNodeKey === "scout")?.status).toBe(
      "failed",
    );
    expect(failed.run.nodes.find((node) => node.templateNodeKey === "planner")?.status).toBe(
      "pending",
    );
    await host.harness.behavior.callRpc("retryStage", { threadId: PARENT, projectId: PROJECT });
    const retried = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { run: { nodes: Array<{ templateNodeKey: string; status: string; childThreadId: string | null }> } };
    const scoutAgain = retried.run.nodes.find((node) => node.templateNodeKey === "scout");
    expect(scoutAgain?.status).toBe("in_progress");
    expect(scoutAgain?.childThreadId).not.toBe(scout.childThreadId);
    expect(retried.run.nodes.find((node) => node.templateNodeKey === "planner")?.status).toBe(
      "pending",
    );
  });

  it("fails an idle child that never submitted a packet", async () => {
    host = await loadPlugin();
    const started = await startDefault(host);
    const scout = started.run?.nodes.find((node) => node.templateNodeKey === "scout") as {
      childThreadId: string;
    };
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: scout.childThreadId,
        projectId: PROJECT,
        environmentId: ENV,
        parentThreadId: PARENT,
        status: "idle",
      }),
      lastAssistantText: "mapped the repo",
    });
    const idle = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as {
      run: {
        controls: { canRetry: boolean };
        nodes: Array<{ templateNodeKey: string; status: string }>;
      };
    };
    expect(idle.run.controls.canRetry).toBe(true);
    expect(idle.run.nodes.find((node) => node.templateNodeKey === "scout")?.status).toBe("failed");
    expect(idle.run.nodes.find((node) => node.templateNodeKey === "planner")?.status).toBe(
      "pending",
    );
  });

  it("keeps a completed child idle from failing the node", async () => {
    host = await loadPlugin();
    await startDefault(host, { runScout: false });
    const latest = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { run: { nodes: Array<{ templateNodeKey: string; childThreadId: string | null }> } };
    const childId = latest.run.nodes.find((node) => node.templateNodeKey === "planner")
      ?.childThreadId as string;
    await host.harness.behavior.callAgentTool(
      "harness_submit_result",
      { role: "planner", kind: "plan_packet", payload: { summary: "plan", nodes: [] } },
      { threadId: childId, projectId: PROJECT },
    );
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: childId,
        projectId: PROJECT,
        environmentId: ENV,
        parentThreadId: PARENT,
        status: "idle",
      }),
      lastAssistantText: "submitted",
    });
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as {
      run: { status: string; nodes: Array<{ templateNodeKey: string; status: string }> };
    };
    expect(status.run.status).toBe("awaiting_plan_approval");
    expect(status.run.nodes.find((node) => node.templateNodeKey === "planner")?.status).toBe(
      "done",
    );
    expect(status.run.nodes.find((node) => node.templateNodeKey === "worker")?.status).toBe(
      "pending",
    );
  });

  it("persists per-node routing and ignores later Settings changes for spawned nodes", async () => {
    host = await loadPlugin();
    await host.harness.behavior.callRpc("setRouting", {
      slot: "explore",
      choice: {
        providerId: "acp-cursor",
        model: "grok-4.6",
        reasoningLevel: "medium",
      },
    });
    const started = await startDefault(host);
    const plannerId = started.run?.nodes.find((node) => node.templateNodeKey === "planner")
      ?.id as string;
    await host.harness.behavior.callRpc("setRunNodeRouting", {
      threadId: PARENT,
      projectId: PROJECT,
      nodeId: plannerId,
      choice: {
        providerId: "pi",
        model: "planner-override",
        reasoningLevel: "high",
      },
    });
    await host.harness.behavior.callRpc("setRouting", {
      slot: "explore",
      choice: {
        providerId: "pi",
        model: "later-settings",
        reasoningLevel: "low",
      },
    });
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as {
      run: {
        nodes: Array<{
          templateNodeKey: string;
          status: string;
          providerId: string | null;
          model: string | null;
        }>;
      };
    };
    const scout = status.run.nodes.find((node) => node.templateNodeKey === "scout");
    const planner = status.run.nodes.find((node) => node.templateNodeKey === "planner");
    expect(scout?.providerId).toBe("acp-cursor");
    expect(scout?.model).toBe("grok-4.6");
    expect(planner?.providerId).toBe("pi");
    expect(planner?.model).toBe("planner-override");
    const scoutChild = started.run?.nodes.find((node) => node.templateNodeKey === "scout")
      ?.childThreadId as string;
    await host.harness.behavior.callAgentTool(
      "harness_submit_result",
      {
        role: "scout",
        kind: "scout_findings",
        payload: { summary: "mapped", findings: ["a"] },
      },
      { threadId: scoutChild, projectId: PROJECT },
    );
    const plannerSpawn = host.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0] as {
      providerId: string;
      model: string;
    };
    expect(plannerSpawn.providerId).toBe("pi");
    expect(plannerSpawn.model).toBe("planner-override");
  });

  it("spawns later nodes in the frozen run environment", async () => {
    host = await loadPlugin();
    await startDefault(host, { runScout: false });
    host.threads.set(
      PARENT,
      makeThreadResponse({
        id: PARENT,
        projectId: PROJECT,
        environmentId: "env_moved",
        providerId: "pi",
      }),
    );
    const latest = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { run: { nodes: Array<{ templateNodeKey: string; childThreadId: string | null }> } };
    const plannerChild = latest.run.nodes.find((node) => node.templateNodeKey === "planner")
      ?.childThreadId as string;
    await host.harness.behavior.callAgentTool(
      "harness_submit_result",
      { role: "planner", kind: "plan_packet", payload: { summary: "plan", nodes: [] } },
      { threadId: plannerChild, projectId: PROJECT },
    );
    await host.harness.behavior.callRpc("approvePlan", { threadId: PARENT, projectId: PROJECT });
    const workerSpawn = host.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0] as {
      environment: { type: string; environmentId: string };
    };
    expect(workerSpawn.environment).toEqual({ type: "reuse", environmentId: ENV });
  });

  it("does not materialize Planner packet nodes into extra Worker run nodes", async () => {
    host = await loadPlugin();
    await startDefault(host, { runScout: false });
    const latest = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { run: { nodes: Array<{ templateNodeKey: string; childThreadId: string | null }> } };
    const plannerChild = latest.run.nodes.find((node) => node.templateNodeKey === "planner")
      ?.childThreadId as string;
    await host.harness.behavior.callAgentTool(
      "harness_submit_result",
      {
        role: "planner",
        kind: "plan_packet",
        payload: {
          summary: "two work items",
          nodes: [
            { id: "w1", title: "First" },
            { id: "w2", title: "Second", deps: ["w1"] },
          ],
        },
      },
      { threadId: plannerChild, projectId: PROJECT },
    );
    await host.harness.behavior.callRpc("approvePlan", { threadId: PARENT, projectId: PROJECT });
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: PARENT,
      projectId: PROJECT,
    })) as { run: { nodes: Array<{ templateNodeKey: string; role: string; status: string }> } };
    const workers = status.run.nodes.filter((node) => node.role === "worker");
    expect(workers.map((node) => node.templateNodeKey)).toEqual(["worker"]);
    expect(workers[0]?.status).toBe("in_progress");
  });

  it("keeps legacy rows readable and migrations repeatable", async () => {
    host = await loadPlugin();
    host.threads.set(
      "thr_legacy",
      makeThreadResponse({
        id: "thr_legacy",
        projectId: PROJECT,
        environmentId: ENV,
      }),
    );
    const db = host.bb.storage.database();
    db.prepare(
      `INSERT INTO arcs (thread_id, project_id, phase, note, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("thr_legacy", PROJECT, "plan", "", Date.now());
    db.prepare(
      `INSERT INTO plans (id, project_id, thread_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("plan1", PROJECT, "thr_legacy", "Legacy", Date.now(), Date.now());
    const listed = (await host.harness.behavior.callRpc("listPlans", {
      projectId: PROJECT,
      threadId: "thr_legacy",
    })) as { plans: Array<{ id: string; name: string }> };
    expect(listed.plans[0]?.name).toBe("Legacy");
    const status = (await host.harness.behavior.callRpc("getStatus", {
      threadId: "thr_legacy",
      projectId: PROJECT,
    })) as { arc: { phase: string }; run: unknown };
    expect(status.arc.phase).toBe("plan");
    expect(status.run).toBeNull();
    host = await host.harness.lifecycle.reload(plugin);
    const again = (await host.harness.behavior.callRpc("listPlans", {
      projectId: PROJECT,
    })) as { plans: Array<{ id: string }> };
    expect(again.plans.some((plan) => plan.id === "plan1")).toBe(true);
  });
});
