// @vitest-environment jsdom
import * as React from "react";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";

let app: CapturedPluginApp;

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
});

const executingV3 = () => ({
  run: {
    id: "run_1",
    homeThreadId: "thr_1",
    objective: "Ship v3",
    state: "Executing",
    revision: 3,
    planRevision: 1,
    plannerThreadId: "thr_planner",
    explorerThreadId: null,
    criticThreadId: null,
    promoterThreadId: null,
    activeWorkerNodeId: null,
    activeWorkerThreadId: null,
    preset: { roles: {} },
  },
  nodes: [
    { id: "a", title: "API", objective: "Build API", dependencies: [], acceptanceCriteria: ["200"], verificationCommands: ["npm test"], expectedArtifacts: [], skillHints: [], status: "done", routingOverride: null },
    { id: "b", title: "UI", objective: "Build UI", dependencies: ["a"], acceptanceCriteria: ["renders"], verificationCommands: [], expectedArtifacts: [], skillHints: [], status: "pending", routingOverride: null },
  ],
  nextNode: { id: "b", title: "UI", objective: "Build UI", dependencies: ["a"], acceptanceCriteria: ["renders"], verificationCommands: [], expectedArtifacts: [], skillHints: [], status: "pending", routingOverride: null },
  doneCount: 1,
  totalCount: 2,
  stateCopy: { title: "Building", body: "Workers are implementing.", primary: "Run next task" },
  skillWarnings: [],
  providerWarnings: [],
  decisions: [],
  artifacts: [],
  evaluation: null,
});

const finalReviewV3 = () => ({
  ...executingV3(),
  run: { ...executingV3().run, state: "FinalReview" },
  stateCopy: { title: "Final review", body: "You decide.", primary: "Decide" },
});

let HarnessV3Panel: (props: { threadId?: string | null }) => React.JSX.Element;
beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
  ({ HarnessV3Panel } = await import("../components/harness-v3-panel"));
});
afterEach(() => cleanup());

describe("Harness v3 panel", () => {
  it("shows one primary action and never raw internals as primary copy", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => executingV3(), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByRole("button", { name: "Run next task" })).toBeTruthy();
    expect(slot.getByText(/1\/2 tasks complete/)).toBeTruthy();
    expect(slot.queryByText(/rev 3/)).toBeNull();
    expect(slot.queryByText(/mutation/)).toBeNull();
    expect(slot.queryByText(/attemptId/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("requires a task before Start v3 Harness becomes enabled", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => inactiveV3(), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    await slot.findByText("Harness v3 (article-aligned arc)");
    const start = slot.getByRole("button", { name: "Start v3 Harness" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(slot.getByPlaceholderText("What should this Harness accomplish?"), { target: { value: "Ship it" } });
    expect((slot.getByRole("button", { name: "Start v3 Harness" }) as HTMLButtonElement).disabled).toBe(false);
    slot.lifecycle.unmount();
  });

  it("critic recommendation never auto-decides; rework needs targets and reason", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => finalReviewV3(), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByRole("button", { name: "Approve" })).toBeTruthy();
    const rework = slot.getByRole("button", { name: "Rework selected" }) as HTMLButtonElement;
    expect(rework.disabled).toBe(true);
    slot.lifecycle.unmount();
  });

  it("keeps audit details collapsed but available", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => executingV3(), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    await slot.findByText("Implementation tasks");
    const details = document.querySelector("details");
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(slot.getByText("Audit details")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("refetches after realtime reconnect and clears on thread switch", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: {
          v3Status: ({ threadId }: { threadId: string }) =>
            threadId === "thr_1" ? executingV3() : new Promise(() => {}),
          v3PresetList: () => ({ presets: [] }),
        },
        context: { projectId: "proj_1", threadId: "thr_1" },
        realtimeConnectionState: "reconnecting",
      },
    );
    await slot.findByRole("button", { name: "Run next task" });
    const before = slot.inspection.rpcCalls.filter((c) => c.method === "v3Status").length;
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.filter((c) => c.method === "v3Status").length).toBeGreaterThan(before);
    });
    slot.lifecycle.unmount();
  });

  it("exposes keyboard-focusable semantic controls", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => executingV3(), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    const primary = await slot.findByRole("button", { name: "Run next task" });
    (primary as HTMLElement).focus();
    expect(document.activeElement).toBe(primary);
    expect(slot.getByRole("list", { name: "Work tasks" })).toBeTruthy();
    slot.lifecycle.unmount();
  });
});

describe("Harness v3 review fixes (panel)", () => {
  const terminalExecuting = () => ({
    ...executingV3(),
    nextNode: null,
    doneCount: 2,
    totalCount: 2,
    nodes: executingV3().nodes.map((n) => ({ ...n, status: "done" as const })),
  });

  const withReports = () => ({
    ...finalReviewV3(),
    decisions: [{ id: "d1", kind: "critic_approved", actor: "operator", reason: "good" }],
    latestReports: {
      exploration: { summary: "Mapped auth seam", findings: ["seam"], risks: [] },
      worker: [
        {
          nodeId: "a",
          outcome: "complete",
          summary: "Built the API",
          changedFiles: ["artifacts/harness/run_1/api.md"],
          acceptanceResults: [{ criterion: "200", met: true, note: "" }],
          commands: [{ command: "npm test", exitCode: 0, output: "ok" }],
          artifactRefs: [],
          risks: [],
        },
      ],
      critic: {
        recommendation: "APPROVE",
        findings: [{ severity: "low", title: "fine", detail: "" }],
        affectedNodeIds: [],
        checksRerun: [{ command: "npm test", exitCode: 0, note: "" }],
        unsupportedClaims: [],
        risks: [],
      },
      promotion: null,
    },
  });

  it("offers Start Critic when the DAG is terminal but still Executing (#2)", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => terminalExecuting(), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByRole("button", { name: "Start Critic" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Run next task" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("renders Explorer, Worker, and Critic reports as decision evidence (#5)", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => withReports(), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByText("Critic recommends APPROVE")).toBeTruthy();
    expect(slot.getByText("Start Promoter")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows promotion controls only after critic approval and gates completion (#6)", async () => {
    // Before approval: decision buttons, no promotion controls.
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => finalReviewV3(), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByRole("button", { name: "Approve" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Start Promoter" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Mark complete" })).toBeNull();
    slot.lifecycle.unmount();
    // After approval: promotion controls + gated completion.
    const approved = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => withReports(), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await approved.findByRole("button", { name: "Start Promoter" })).toBeTruthy();
    expect(approved.getByRole("button", { name: "Skip communication" })).toBeTruthy();
    expect(approved.getByRole("button", { name: "Mark complete" })).toBeTruthy();
    approved.lifecycle.unmount();
  });

  it("hides completion while a started promotion has no report (#6)", async () => {
    const promoting = {
      ...withReports(),
      run: { ...withReports().run, state: "Promoting" },
      stateCopy: { title: "Share", body: "Promoting.", primary: "View Promoter" },
    };
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => promoting, v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    await slot.findByText(/Completion unlocks when its report lands/);
    expect(slot.queryByRole("button", { name: "Mark complete" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("selects the working conversation by state, not a fixed priority (#7)", async () => {
    const { selectChatThread } = await import("../components/harness-v3-panel");
    const base = {
      id: "r",
      homeThreadId: "h",
      objective: "o",
      revision: 1,
      planRevision: 1,
      plannerThreadId: "planner",
      explorerThreadId: "explorer",
      criticThreadId: "critic",
      promoterThreadId: "promoter",
      activeWorkerNodeId: "a",
      activeWorkerThreadId: "worker",
      preset: { roles: {} },
    };
    expect(selectChatThread({ ...base, state: "Exploring" })).toBe("explorer");
    expect(selectChatThread({ ...base, state: "Planning" })).toBe("planner");
    expect(selectChatThread({ ...base, state: "WorkerReview" })).toBe("worker");
    expect(selectChatThread({ ...base, state: "FinalReview" })).toBe("critic");
    // Promoter wins in Promoting even though every other thread is set.
    expect(selectChatThread({ ...base, state: "Promoting" })).toBe("promoter");
    expect(selectChatThread({ ...base, state: "Complete" })).toBeNull();
    expect(selectChatThread(null)).toBeNull();
  });

  it("targets artifacts at the run environment, not the project id (#8)", async () => {
    const { artifactTarget } = await import("../components/harness-v3-panel");
    const run = { environmentId: "env_live" } as never;
    expect(artifactTarget(run, "artifacts/harness/r/plan.md")).toEqual({
      kind: "workspace",
      environmentId: "env_live",
      path: "artifacts/harness/r/plan.md",
    });
  });

  it("keeps raw internals out of the audit surface (#5, #8)", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => withReports(), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    await slot.findByText("Audit details");
    expect(slot.queryByText(/attemptId/)).toBeNull();
    expect(slot.queryByText(/--- a\/plan\.md/)).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("Harness v3 worker accept gating", () => {
  const workerReview = (outcome: string, attemptMatch: boolean) => ({
    run: {
      id: "run_1",
      homeThreadId: "thr_1",
      objective: "Ship v3",
      state: "WorkerReview",
      revision: 5,
      planRevision: 1,
      plannerThreadId: "thr_planner",
      explorerThreadId: null,
      criticThreadId: null,
      promoterThreadId: null,
      activeWorkerNodeId: "b",
      activeWorkerThreadId: "thr_worker",
      preset: { roles: {} },
    },
    nodes: [
      { id: "a", title: "API", objective: "Build API", dependencies: [], acceptanceCriteria: ["200"], verificationCommands: [], expectedArtifacts: [], skillHints: [], status: "done", attemptId: "att-a", routingOverride: null },
      { id: "b", title: "UI", objective: "Build UI", dependencies: ["a"], acceptanceCriteria: ["renders"], verificationCommands: [], expectedArtifacts: [], skillHints: [], status: "awaiting_review", attemptId: "att-b", routingOverride: null },
    ],
    nextNode: null,
    doneCount: 1,
    totalCount: 2,
    stateCopy: { title: "Worker review", body: "Review.", primary: "Review worker report" },
    skillWarnings: [],
    providerWarnings: [],
    decisions: [],
    artifacts: [],
    evaluation: null,
    latestReports: {
      exploration: null,
      worker: [
        {
          nodeId: "b",
          attemptId: attemptMatch ? "att-b" : "att-stale",
          outcome,
          summary: "Tried the UI",
          changedFiles: [],
          acceptanceResults: [],
          commands: [],
          artifactRefs: [],
          risks: [],
        },
      ],
      critic: null,
      promotion: null,
    },
  });

  it("disables Accept for blocked outcomes and guides toward Request changes", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => workerReview("blocked", true), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    expect(await slot.findByText(/Worker reported “blocked”/)).toBeTruthy();
    expect((slot.getByRole("button", { name: "Accept worker" }) as HTMLButtonElement).disabled).toBe(true);
    slot.lifecycle.unmount();
  });

  it("disables Accept when the visible report belongs to a stale attempt", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => workerReview("complete", false), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    await slot.findByText("Waiting for the Worker report for this attempt…");
    expect((slot.getByRole("button", { name: "Accept worker" }) as HTMLButtonElement).disabled).toBe(true);
    slot.lifecycle.unmount();
  });

  it("enables Accept for a complete report on the current attempt", async () => {
    const slot = renderSlot(
      { component: HarnessV3Panel },
      { threadId: "thr_1" },
      {
        rpc: { v3Status: () => workerReview("complete", true), v3PresetList: () => ({ presets: [] }) },
        context: { projectId: "proj_1", threadId: "thr_1" },
      },
    );
    const accept = (await slot.findByRole("button", { name: "Accept worker" })) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    slot.lifecycle.unmount();
  });
});
