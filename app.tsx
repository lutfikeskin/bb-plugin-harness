// bb-plugin-harness — frontend: opt-in run panel, header/command entry, banner.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import {
  HarnessBanner,
  HarnessHeaderAction,
  HarnessPanel,
} from "./components/harness-panel";
import { HarnessSettings } from "./components/harness-settings";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "arc",
    title: "Harness",
    icon: "Workflow",
    path: "arc",
    component: () => <HarnessPanel />,
  });

  app.slots.threadPanelAction({
    id: "arc",
    title: "Harness",
    icon: "Workflow",
    layout: "flush",
    run: async ({ openPanel }) => {
      openPanel({ title: "Harness" });
    },
    component: ({ threadId }) => <HarnessPanel threadId={threadId} />,
  });

  app.slots.experimental_threadHeaderAction({
    id: "open-harness",
    title: "Harness",
    component: HarnessHeaderAction,
  });

  app.slots.commandPaletteAction({
    id: "open-harness",
    title: "Harness: open panel",
    isAvailable: ({ threadId }) => threadId != null,
    run: ({ openPanel }) => {
      openPanel({ actionId: "arc", title: "Harness" });
    },
  });

  app.slots.settingsSection({
    id: "routing",
    title: "Role routing",
    description:
      "Provider and model for each Harness role. Every run node spawns a visible child with the selection unless that node overrides it. v1 runs one fixed Worker + Tester after plan approval.",
    component: HarnessSettings,
  });

  app.composer.customize({
    id: "harness-arc",
    scopes: ["thread"],
    banners: [{ id: "arc", chrome: "bare", component: HarnessBanner }],
  });
});
