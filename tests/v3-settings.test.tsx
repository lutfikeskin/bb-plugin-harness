// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import { emptyRoleRouting } from "../lib/harness";

let app: CapturedPluginApp;
beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});
afterEach(() => cleanup());

const preset = (overrides: Record<string, unknown> = {}) => ({
  id: "preset_1",
  name: "Balanced",
  scope: "global",
  projectId: null,
  roles: {
    explorer: { choice: null, permissionMode: null, skillHints: [] },
    planner: { choice: null, permissionMode: null, skillHints: [] },
    workerFirst: { choice: null, permissionMode: null, skillHints: [] },
    workerRest: { choice: null, permissionMode: null, skillHints: [] },
    critic: { choice: null, permissionMode: null, skillHints: [] },
    promoter: { choice: null, permissionMode: null, skillHints: [] },
  },
  promotionMode: "ask",
  artifactPolicy: "advisory",
  ...overrides,
});

describe("Harness v3 preset editor", () => {
  it("lists presets with per-role permission controls and policy selects", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getRouting: () => ({ routing: emptyRoleRouting() }),
          v3PresetList: () => ({ presets: [preset()] }),
        },
      },
    );
    expect(await slot.findByText("Role presets (v3)")).toBeTruthy();
    await waitFor(() => {
      expect((slot.getByLabelText("Name") as HTMLInputElement).value).toBe("Balanced");
    });
    // v3-only role labels render exactly once; shared names appear in both editors.
    for (const label of ["First Worker", "Later Workers"]) {
      expect(slot.getByText(label)).toBeTruthy();
    }
    expect(slot.getAllByText("Critic").length).toBeGreaterThanOrEqual(2);
    expect(slot.getByLabelText("Promotion")).toBeTruthy();
    expect(slot.getByLabelText("Artifacts")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("saves edits through v3PresetUpdate without touching legacy routing", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getRouting: () => ({ routing: emptyRoleRouting() }),
          v3PresetList: () => ({ presets: [preset()] }),
          v3PresetUpdate: (input: unknown) => {
            calls.push({ method: "v3PresetUpdate", input });
            return { preset: preset({ name: (input as { name: string }).name }) };
          },
        },
      },
    );
    await slot.findByText("Role presets (v3)");
    fireEvent.change(slot.getByLabelText("Name"), { target: { value: "Balanced v2" } });
    fireEvent.click(slot.getByRole("button", { name: "Save preset" }));
    await slot.findByDisplayValue("Balanced v2");
    expect(calls).toHaveLength(1);
    expect(slot.inspection.rpcCalls.some((c) => c.method === "setRouting")).toBe(false);
    slot.lifecycle.unmount();
  });
});
