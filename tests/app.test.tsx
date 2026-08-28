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
      harnessSnapshot: null,
      totals: {
        durationMs: 12,
        tokens: { input: 3, cached: 0, output: 1, reasoning: 0, total: 4 },
      },
      skillWarnings: [],
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
    expect(slot.inspection.rpcCalls.every((call) => call.method === "getStatus")).toBe(true);
    slot.lifecycle.unmount();
  });

  it("starts Standard Harness by default without Milestone fields", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () => emptyStatus(),
          startRun: () => emptyStatus(),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    await slot.findByText("Harness is inactive");
    expect(slot.queryByLabelText("Run Scout")).toBeNull();
    expect(slot.queryByText("Milestone")).toBeNull();
    fireEvent.change(slot.getByLabelText("Task"), {
      target: { value: "Ship Standard Harness" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Start Harness" }));
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.some((call) => call.method === "startRun")).toBe(true);
    });
    expect(slot.inspection.rpcCalls.find((call) => call.method === "startRun")?.input).toMatchObject({
      harnessId: STANDARD_HARNESS_ID,
      objective: "Ship Standard Harness",
    });
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
    expect(slot.getByText("Plan")).toBeTruthy();
    expect(slot.getByText("Worker (first node)")).toBeTruthy();
    expect(slot.getByText("Critic")).toBeTruthy();
    expect(slot.queryByText("Explore / Scout")).toBeNull();
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

  it("creates a custom Harness from Standard", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () => emptyStatus(),
          createHarness: (input: { name: string }) => ({
            harness: {
              id: "c-careful-aaaaaaaa",
              name: input.name,
              description: "custom",
              kind: "custom",
              engine: "manual",
              schemaVersion: 2 as const,
              artifactPolicy: "advisory" as const,
              promoteMode: "always" as const,
              maxCorrections: null,
              phases: {
                explore: { title: "e", detail: "d", execution: "parent" as const, skills: [] },
                plan: { title: "p", detail: "d", execution: "parent" as const, skills: [] },
                worker: { title: "w", detail: "d", execution: "child" as const, skills: [] },
                critic: { title: "c", detail: "d", execution: "child" as const, skills: [] },
                promote: { title: "pr", detail: "d", execution: "child" as const, skills: [] },
              },
              createdAt: 1,
              updatedAt: 1,
            },
          }),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    await slot.findByText("Create Harness");
    fireEvent.click(slot.getByRole("button", { name: "Create Harness" }));
    fireEvent.change(slot.getByLabelText("Harness name"), {
      target: { value: "Careful ship" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save Harness" }));
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.some((call) => call.method === "createHarness")).toBe(true);
    });
    slot.lifecycle.unmount();
  });

  it("surfaces custom Harness mutation errors", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getStatus: () => emptyStatus(),
          createHarness: () => {
            throw new Error("At most 32 custom Harnesses can be saved.");
          },
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    await slot.findByText("Create Harness");
    fireEvent.click(slot.getByRole("button", { name: "Create Harness" }));
    fireEvent.click(slot.getByRole("button", { name: "Save Harness" }));
    expect((await slot.findByRole("alert")).textContent).toMatch(/at most 32/i);
    slot.lifecycle.unmount();
  });

  it("renders manual arc controls, DAG Start/Done, totals, and Add Worker", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: { getStatus: () => activeStatus() },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByRole("button", { name: "Advance" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Rewind" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(slot.getAllByRole("button", { name: "Start" }).length).toBeGreaterThan(0);
    expect(slot.getByRole("button", { name: "Add Worker" })).toBeTruthy();
    expect(slot.getByText(/tokens 4/)).toBeTruthy();
    expect(slot.queryByText("Harness is inactive")).toBeNull();
    expect(slot.queryByText("Current stage:")).toBeNull();
    slot.lifecycle.unmount();
  });
});
