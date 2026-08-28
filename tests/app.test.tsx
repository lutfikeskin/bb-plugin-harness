// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useState } from "react";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import type { HarnessStatusDto } from "../server";
import { emptyRoleRouting } from "../lib/harness";
import { MILESTONE_PIPELINE_ID } from "../lib/run-engine";

let app: CapturedPluginApp;

const emptyStatus = (threadId = "thr_1"): HarnessStatusDto => ({
  arc: {
    threadId,
    projectId: "proj_1",
    phase: "explore",
    note: "",
    updatedAt: 0,
  },
  plan: null,
  nextNode: null,
  tier: "commodity",
  commodityModel: "cheap",
  frontierModel: "dear",
  prewalkEnabled: true,
  routing: emptyRoleRouting(),
  run: null,
});

function runNode(
  extra: Partial<NonNullable<HarnessStatusDto["run"]>["nodes"][number]> & {
    id: string;
    role: NonNullable<HarnessStatusDto["run"]>["nodes"][number]["role"];
  },
): NonNullable<HarnessStatusDto["run"]>["nodes"][number] {
  return {
    runId: "run_1",
    templateNodeKey: extra.role,
    phase: "explore",
    ordinal: 0,
    status: "pending",
    deps: [],
    childThreadId: null,
    providerId: null,
    model: null,
    reasoningLevel: null,
    serviceTier: null,
    startedAt: null,
    completedAt: null,
    packetVersion: 0,
    child: null,
    ...extra,
  };
}

function runStatus(args: {
  status: NonNullable<HarnessStatusDto["run"]>["status"];
  controls?: Partial<NonNullable<HarnessStatusDto["run"]>["controls"]>;
  nodes?: NonNullable<HarnessStatusDto["run"]>["nodes"];
  packets?: NonNullable<HarnessStatusDto["run"]>["packets"];
}): HarnessStatusDto {
  const nodes =
    args.nodes ??
    [
      runNode({
        id: "node_scout",
        role: "scout",
        status: "in_progress",
        childThreadId: "thr_child",
        child: {
          id: "thr_child",
          title: "Scout",
          status: "active",
          providerId: "pi",
        },
      }),
    ];
  const currentNode = nodes.find((node) => node.status === "in_progress") ?? null;
  return {
    ...emptyStatus(),
    arc: { ...emptyStatus().arc, phase: currentNode?.phase ?? "explore" },
    run: {
      id: "run_1",
      projectId: "proj_1",
      parentThreadId: "thr_1",
      templateId: MILESTONE_PIPELINE_ID,
      status: args.status,
      currentStageId: currentNode?.id ?? null,
      taskPacket: {
        objective: "Ship the UI",
        branch: null,
        execPlanPath: null,
        protectedPaths: [],
        runScout: true,
        specialistQuestion: null,
        routingOverrides: null,
        projectId: "proj_1",
        parentThreadId: "thr_1",
        environmentId: "env_1",
        promptVersion: "harness-role-prompts@1",
        schemaVersion: "harness-packets@1",
      },
      correctionCount: 0,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null,
      nodes,
      packets: args.packets ?? [],
      currentNode,
      controls: {
        canApprovePlan: false,
        canApproveCorrection: false,
        canStop: args.status === "running" || args.status.startsWith("awaiting"),
        canRetry: false,
        ...args.controls,
      },
    },
  };
}

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});

afterEach(() => {
  cleanup();
});

describe("Harness UI activation", () => {
  it("registers header, panel, and settings entry points", () => {
    expect(app.threadPanelActions[0]?.id).toBe("arc");
    expect(app.threadHeaderActions[0]?.id).toBe("open-harness");
    expect(app.settingsSections[0]?.title).toBe("Role routing");
    expect(app.composerCustomizations[0]?.banners?.[0]?.id).toBe("arc");
  });

  it("renders an inactive Start Harness CTA without starting a run", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () => emptyStatus(),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByText("Harness is inactive")).toBeTruthy();
    const start = slot.getByRole("button", { name: "Start Harness" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(
      slot.inspection.rpcCalls.every((call) => call.method === "getStatus"),
    ).toBe(true);
    slot.lifecycle.unmount();
  });

  it("disables Start without a task and submits the Task Packet when started", async () => {
    let active = false;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () => (active ? runStatus({ status: "running" }) : emptyStatus()),
          startRun: (input) => {
            active = true;
            return runStatus({ status: "running" });
          },
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    await slot.findByText("Harness is inactive");
    const start = slot.getByRole("button", { name: "Start Harness" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(start);
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "startRun"),
    ).toBe(false);

    fireEvent.change(slot.getByLabelText("Task"), {
      target: { value: "Implement UI activation" },
    });
    fireEvent.click(slot.getByText("Optional fields"));
    fireEvent.change(slot.getByLabelText("ExecPlan path"), {
      target: { value: "plans/opt-in-harness-orchestration-plan.md" },
    });
    fireEvent.change(slot.getByLabelText("Branch"), {
      target: { value: "pipeline-migration" },
    });
    fireEvent.change(slot.getByLabelText("Protected paths"), {
      target: { value: "secrets.env, core/legacy" },
    });
    fireEvent.click(slot.getByLabelText("Run Scout"));
    fireEvent.click(slot.getByRole("button", { name: "Start Harness" }));

    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.some((call) => call.method === "startRun"),
      ).toBe(true);
    });
    const startCall = slot.inspection.rpcCalls.find(
      (call) => call.method === "startRun",
    );
    expect(startCall?.input).toMatchObject({
      threadId: "thr_1",
      projectId: "proj_1",
      objective: "Implement UI activation",
      templateId: MILESTONE_PIPELINE_ID,
      runScout: false,
      execPlanPath: "plans/opt-in-harness-orchestration-plan.md",
      branch: "pipeline-migration",
      protectedPaths: ["secrets.env", "core/legacy"],
    });
    expect(await slot.findByText("Current stage:")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("renders nothing in the composer banner when the thread is inactive", async () => {
    const banner = app.composerCustomizations[0]!.banners![0]!;
    const slot = renderSlot(
      { component: banner.component },
      {},
      {
        rpc: { getStatus: () => emptyStatus() },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.some((call) => call.method === "getStatus")).toBe(
        true,
      );
    });
    expect(slot.queryByText(/Harness ·/)).toBeNull();
    expect(
      slot.inspection.rpcCalls.every((call) => call.method === "getStatus"),
    ).toBe(true);
    slot.lifecycle.unmount();
  });

  it("shows the current stage and a child Open action on an active run", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: { getStatus: () => runStatus({ status: "running" }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByText("Current stage:")).toBeTruthy();
    expect(slot.getAllByText("Scout").length).toBeGreaterThan(0);
    fireEvent.click(slot.getByRole("button", { name: "Open" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_child",
    });
    expect(slot.queryByRole("button", { name: "Approve Plan" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Run Correction" })).toBeNull();
    expect(slot.getByRole("button", { name: "Stop" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows plan approval, correction, retry, and stop only in valid states", async () => {
    const plan = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () =>
            runStatus({
              status: "awaiting_plan_approval",
              controls: { canApprovePlan: true, canStop: true },
            }),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await plan.findByRole("button", { name: "Approve Plan" })).toBeTruthy();
    expect(plan.queryByRole("button", { name: "Run Correction" })).toBeNull();
    expect(plan.queryByRole("button", { name: "Retry" })).toBeNull();
    plan.lifecycle.unmount();

    const correction = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () =>
            runStatus({
              status: "awaiting_correction_approval",
              controls: { canApproveCorrection: true, canStop: true },
            }),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(
      await correction.findByRole("button", { name: "Run Correction" }),
    ).toBeTruthy();
    expect(correction.queryByRole("button", { name: "Approve Plan" })).toBeNull();
    correction.lifecycle.unmount();

    const retry = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () =>
            runStatus({
              status: "running",
              controls: { canRetry: true, canStop: true },
            }),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await retry.findByRole("button", { name: "Retry" })).toBeTruthy();
    retry.lifecycle.unmount();
  });

  it("opens the Harness panel from the thread header action", async () => {
    const slot = renderSlot(
      app.threadHeaderActions[0]!,
      { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false },
      { openThreadPanel: () => true },
    );
    fireEvent.click(slot.getByRole("button", { name: "Start Harness" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "arc", title: "Harness" },
    });
    slot.lifecycle.unmount();
  });

  it("labels settings with agent roles", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: { getRouting: () => ({ routing: emptyRoleRouting() }) },
      },
    );
    expect(await slot.findByText("Scout / Specialist")).toBeTruthy();
    expect(slot.getByText("Planner")).toBeTruthy();
    expect(slot.getByText("Worker + Tester (first node)")).toBeTruthy();
    expect(slot.getByText("Reviewer")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("refetches durable status after realtime reconnect", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: { getStatus: () => emptyStatus() },
        context: { projectId: "proj_1", threadId: "thr_1" },
        realtimeConnectionState: "reconnecting",
      },
    );
    await slot.findByText("Harness is inactive");
    const before = slot.inspection.rpcCalls.filter(
      (call) => call.method === "getStatus",
    ).length;
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "getStatus")
          .length,
      ).toBeGreaterThan(before);
    });
    slot.lifecycle.unmount();
  });

  it("clears panel and banner before controls can act after a thread switch", async () => {
    let setThreadId: (id: string) => void = () => {};
    const Panel = app.threadPanelActions[0]!.component;
    const Banner = app.composerCustomizations[0]!.banners![0]!.component;
    function Switchable() {
      const [threadId, setId] = useState("thr_1");
      setThreadId = setId;
      return (
        <>
          <Panel threadId={threadId} params={null} />
          <Banner threadId={threadId} />
        </>
      );
    }
    const slot = renderSlot(
      { component: Switchable },
      {},
      {
        rpc: {
          getStatus: ({ threadId }: { threadId: string }) =>
            threadId === "thr_1"
              ? runStatus({ status: "running", controls: { canStop: true } })
              : new Promise<HarnessStatusDto>(() => {}),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByText("Current stage:")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(slot.getByText(/Harness · Explore/)).toBeTruthy();
    act(() => {
      setThreadId("thr_ordinary");
    });
    expect(slot.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(slot.queryByText("Current stage:")).toBeNull();
    expect(slot.queryByText(/Harness · Explore/)).toBeNull();
    expect(slot.getByText("Loading harness…")).toBeTruthy();
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "stopRun"),
    ).toBe(false);
    slot.lifecycle.unmount();
  });
});
