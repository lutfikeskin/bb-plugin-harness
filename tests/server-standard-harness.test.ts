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

async function loadPlugin() {
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
        spawn: async () => {
          throw new Error("standard start must not spawn a child");
        },
      },
    },
  });
  await plugin(host.bb);
  return Object.assign(host, { threads });
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
});
