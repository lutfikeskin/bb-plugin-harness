// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import type { HarnessStatusDto } from "../server";
import { emptyRoleRouting } from "../lib/harness";
import { STANDARD_HARNESS_ID } from "../lib/definitions";

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
  harness: null,
  customHarnesses: [],
});

const inactiveV3 = () => ({
  run: null,
  nodes: [],
  nextNode: null,
  doneCount: 0,
  totalCount: 0,
  stateCopy: { title: "Harness is inactive", body: "Ordinary chat.", primary: "Start Harness" },
  skillWarnings: [],
  providerWarnings: [],
  decisions: [],
  artifacts: [],
  evaluation: null,
  currentReviewApproved: false,
  promotionSkipped: false,
  failedRoles: [],
  exportWarnings: [],
  nextNodeRouting: null,
  latestReports: { exploration: null, worker: [], critic: null, promotion: null },
});

function activeStatus(): HarnessStatusDto {
  const planId = "plan_std";
  return {
    ...emptyStatus(),
    harness: {
      id: STANDARD_HARNESS_ID,
      name: "Standard Harness",
      description: "default",
      kind: "builtin",
      engine: "manual",
    },
    arc: {
      threadId: "thr_1",
      projectId: "proj_1",
      phase: "explore",
      note: "Ship it",
      updatedAt: 2,
    },
    plan: {
      id: planId,
      projectId: "proj_1",
      threadId: "thr_1",
      name: "Ship it",
      createdAt: 1,
      updatedAt: 1,
      nodeCount: 5,
      doneCount: 0,
      harnessId: STANDARD_HARNESS_ID,
      correctionCount: 0,
      criticBlocked: false,
      lifecycle: "active",
      revision: 0,
      harnessSnapshot: null,
      totals: {
        durationMs: 12,
        tokens: { input: 3, cached: 0, output: 1, reasoning: 0, total: 4 },
      },
      skillWarnings: [],
      mutations: [],
      nodes: ["explore", "plan", "worker", "critic", "promote"].map((phase, index) => ({
        id: `${planId}-${phase}`,
        title: phase,
        detail: "",
        phase: phase as HarnessStatusDto["arc"]["phase"],
        status: phase === "explore" ? "in_progress" : "pending",
        deps: [],
        sortOrder: index,
        childThreadId: null,
        providerId: null,
        model: null,
        reasoningLevel: null,
        serviceTier: null,
        execution: phase === "explore" || phase === "plan" ? "parent" : "child",
        skills: [],
        revision: 0,
        child: null,
        result: null,
        attempt: null,
        attempts: [],
      })),
    },
  };
}

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("Harness UI activation", () => {
  it("registers header, panel, and settings entry points", () => {
    expect(app.threadPanelActions[0]?.id).toBe("arc");
    expect(app.threadHeaderActions[0]?.id).toBe("open-harness");
    expect(app.settingsSections[0]?.title).toBe("Role routing");
    expect(app.composerCustomizations[0]?.banners?.[0]?.id).toBe("arc");
  });

  it("renders only the v3 start surface on an ordinary thread (no legacy start)", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () => emptyStatus(),
          v3Status: () => inactiveV3(),
          v3PresetList: () => ({ presets: [] }),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByText("Harness v3 (article-aligned arc)")).toBeTruthy();
    const start = slot.getByRole("button", { name: "Start v3 Harness" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    // No legacy start surface: no legacy CTA, no legacy start calls.
    expect(slot.queryByRole("button", { name: "Start Harness" })).toBeNull();
    expect(slot.queryByText("Harness is inactive")).toBeNull();
    expect(slot.queryByText("Legacy run")).toBeNull();
    expect(slot.inspection.rpcCalls.every((call) => call.method === "getStatus" || call.method === "v3Status" || call.method === "v3PresetList")).toBe(true);
    expect(slot.inspection.rpcCalls.some((call) => call.method === "startRun" || call.method === "v3Start")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("starts v3 Harness from the single start surface", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () => emptyStatus(),
          v3Status: () => inactiveV3(),
          v3PresetList: () => ({ presets: [] }),
          v3Start: () => ({}),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    await slot.findByText("Harness v3 (article-aligned arc)");
    expect(slot.queryByText("Milestone")).toBeNull();
    // Let both status and preset fetches settle so the button node is stable.
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.some((call) => call.method === "v3PresetList")).toBe(true);
    });
    fireEvent.change(slot.getByLabelText("Task"), {
      target: { value: "Ship v3 Harness" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Start v3 Harness" }));
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.some((call) => call.method === "v3Start")).toBe(true);
    });
    expect(slot.inspection.rpcCalls.find((call) => call.method === "v3Start")?.input).toMatchObject({
      objective: "Ship v3 Harness",
    });
    expect(slot.inspection.rpcCalls.some((call) => call.method === "startRun")).toBe(false);
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
      expect(slot.inspection.rpcCalls.some((call) => call.method === "getStatus")).toBe(true);
    });
    expect(slot.queryByText(/Harness ·/)).toBeNull();
    slot.lifecycle.unmount();
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

  it("labels settings with Standard role names", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: { getRouting: () => ({ routing: emptyRoleRouting() }) },
      },
    );
    expect(await slot.findByText("Explore")).toBeTruthy();
    // v3 preset editor shares the Critic name with legacy routing; both render.
    expect(slot.getByText("Plan")).toBeTruthy();
    expect(slot.getByText("Worker (first node)")).toBeTruthy();
    expect(slot.getAllByText("Critic").length).toBeGreaterThanOrEqual(2);
    expect(slot.queryByText("Explore / Scout")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("refetches durable status after realtime reconnect", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () => emptyStatus(),
          v3Status: () => inactiveV3(),
          v3PresetList: () => ({ presets: [] }),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
        realtimeConnectionState: "reconnecting",
      },
    );
    await slot.findByText("Harness v3 (article-aligned arc)");
    const before = slot.inspection.rpcCalls.filter((call) => call.method === "getStatus").length;
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "getStatus").length,
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
            threadId === "thr_1" ? activeStatus() : new Promise<HarnessStatusDto>(() => {}),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByRole("button", { name: "Stop" })).toBeTruthy();
    expect(slot.getByText(/Harness · Explore/)).toBeTruthy();
    act(() => {
      setThreadId("thr_ordinary");
    });
    expect(slot.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(slot.queryByText(/Harness · Explore/)).toBeNull();
    expect(slot.getByText("Loading harness…")).toBeTruthy();
    expect(slot.inspection.rpcCalls.some((call) => call.method === "stopRun")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("requires state-aware confirmation and revision provenance before Stop", async () => {
    const confirm = vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () => activeStatus(),
          stopRun: () => emptyStatus(),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    const stop = await slot.findByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    expect(slot.inspection.rpcCalls.some((call) => call.method === "stopRun")).toBe(false);
    fireEvent.click(stop);
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.some((call) => call.method === "stopRun")).toBe(true);
    });
    expect(confirm.mock.calls[0]?.[0]).toMatch(/active Explore node/i);
    expect(slot.inspection.rpcCalls.find((call) => call.method === "stopRun")?.input).toMatchObject({
      expectedRevision: 0,
      reason: expect.stringMatching(/confirmed cancellation/i),
    });
    confirm.mockRestore();
    slot.lifecycle.unmount();
  });

  it("renders manual arc controls, DAG Start/Done, totals, and Add Worker", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () => activeStatus(),
          v3Status: () => inactiveV3(),
          v3PresetList: () => ({ presets: [] }),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByRole("button", { name: "Stop" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Advance" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Rewind" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Reopen Worker" })).toBeNull();
    expect(slot.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(slot.getAllByRole("button", { name: "Start" }).length).toBeGreaterThan(0);
    expect(slot.getByRole("button", { name: "Add Worker" })).toBeTruthy();
    expect(slot.getByText(/tokens 4/)).toBeTruthy();
    expect(slot.getByText("Legacy run (v0.1/v2)")).toBeTruthy();
    expect(slot.queryByText("Harness is inactive")).toBeNull();
    expect(slot.queryByText("Current stage:")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows the v3 banner state for an active v3 run", async () => {
    const banner = app.composerCustomizations[0]!.banners![0]!;
    const slot = renderSlot(
      { component: banner.component },
      {},
      {
        rpc: {
          getStatus: () => emptyStatus(),
          v3Status: () => ({ run: { state: "Executing" } }),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByText("Harness · Executing")).toBeTruthy();
    slot.lifecycle.unmount();
  });
});
