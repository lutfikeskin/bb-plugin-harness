import {
  DEFAULT_PHASE_SPECS,
  PHASES,
  seedArcNodes,
  type Phase,
  type PhaseSpec,
} from "./harness";
import { MILESTONE_PIPELINE_ID } from "./run-engine";

export const STANDARD_HARNESS_ID = "standard";
export const CUSTOM_HARNESSES_KEY = "custom-harnesses";
export const MAX_CUSTOM_HARNESSES = 32;
export const MAX_CUSTOM_HARNESSES_BYTES = 200_000;

export const HARNESS_ENGINES = ["manual", "milestone"] as const;
export type HarnessEngine = (typeof HARNESS_ENGINES)[number];

export const HARNESS_KINDS = ["builtin", "custom"] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

export type HarnessDefinition = {
  id: string;
  name: string;
  description: string;
  kind: HarnessKind;
  engine: HarnessEngine;
  phases: Record<Phase, PhaseSpec>;
  createdAt: number;
  updatedAt: number;
};

export type HarnessRef = {
  id: string;
  name: string;
  description: string;
  kind: HarnessKind;
  engine: HarnessEngine;
};

const ID_PATTERN = /^[a-z][a-z0-9-]{1,47}$/;

export function isHarnessEngine(value: string): value is HarnessEngine {
  return (HARNESS_ENGINES as readonly string[]).includes(value);
}

export function isHarnessKind(value: string): value is HarnessKind {
  return (HARNESS_KINDS as readonly string[]).includes(value);
}

export function isReservedHarnessId(id: string): boolean {
  return id === STANDARD_HARNESS_ID || id === MILESTONE_PIPELINE_ID;
}

export function standardHarnessDefinition(now = 0): HarnessDefinition {
  return {
    id: STANDARD_HARNESS_ID,
    name: "Standard Harness",
    description:
      "Explore → Plan → Worker → Critic → Promote. Explore and Plan stay on the parent thread. Worker, Critic, and Promote spawn visible children. Critic may rewind Worker. Promote communicates.",
    kind: "builtin",
    engine: "manual",
    phases: { ...DEFAULT_PHASE_SPECS },
    createdAt: now,
    updatedAt: now,
  };
}

export function milestoneHarnessDefinition(now = 0): HarnessDefinition {
  return {
    id: MILESTONE_PIPELINE_ID,
    name: "Milestone Pipeline",
    description:
      "Optional specialized Harness: Scout, optional Specialist, Planner approval, one fixed Worker + Tester, Reviewer, one bounded correction, then Promote.",
    kind: "builtin",
    engine: "milestone",
    phases: {
      explore: {
        title: "Scout the problem",
        detail: "Map the problem. Do not implement. Optional Specialist answers one question.",
      },
      plan: {
        title: "Write the plan packet",
        detail: "Submit a plan packet. The operator must approve before Worker starts.",
      },
      worker: {
        title: "Implement one bounded unit",
        detail: "v1 runs one Worker + Tester after approval, plus one optional correction.",
      },
      critic: {
        title: "Review independently",
        detail: "Return APPROVE, CORRECTION_REQUIRED, or BLOCKED.",
      },
      promote: {
        title: "Promote the result",
        detail: "Report the outcome and stop. Do not start follow-up work.",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function builtinHarnesses(now = 0): HarnessDefinition[] {
  return [standardHarnessDefinition(now), milestoneHarnessDefinition(now)];
}

export function toHarnessRef(definition: HarnessDefinition): HarnessRef {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    kind: definition.kind,
    engine: definition.engine,
  };
}

function parsePhaseSpecs(value: unknown): Record<Phase, PhaseSpec> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const phases = { ...DEFAULT_PHASE_SPECS };
  for (const phase of PHASES) {
    const spec = record[phase];
    if (!spec || typeof spec !== "object") return null;
    const item = spec as Record<string, unknown>;
    if (typeof item.title !== "string" || typeof item.detail !== "string") return null;
    const title = item.title.trim() || DEFAULT_PHASE_SPECS[phase].title;
    const detail = item.detail.trim() || DEFAULT_PHASE_SPECS[phase].detail;
    if (title.length > 200) return null;
    if (detail.length > 4000) return null;
    phases[phase] = { title, detail };
  }
  return phases;
}

export function parseHarnessDefinition(value: unknown): HarnessDefinition | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) return null;
  if (typeof record.name !== "string") return null;
  const name = record.name.trim();
  if (name.length < 1 || name.length > 80) return null;
  if (typeof record.description !== "string") return null;
  const description = record.description.trim();
  if (description.length > 500) return null;
  if (typeof record.kind !== "string" || !isHarnessKind(record.kind)) return null;
  if (typeof record.engine !== "string" || !isHarnessEngine(record.engine)) return null;
  if (record.kind === "builtin" && !isReservedHarnessId(record.id)) return null;
  if (record.kind === "custom" && isReservedHarnessId(record.id)) return null;
  if (record.kind === "custom" && record.engine !== "manual") return null;
  const phases = parsePhaseSpecs(record.phases);
  if (!phases) return null;
  const createdAt = typeof record.createdAt === "number" ? record.createdAt : 0;
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : createdAt;
  return {
    id: record.id,
    name,
    description,
    kind: record.kind,
    engine: record.engine,
    phases,
    createdAt,
    updatedAt,
  };
}

export function parseCustomHarnesses(value: unknown): HarnessDefinition[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: HarnessDefinition[] = [];
  for (const item of value) {
    const parsed = parseHarnessDefinition(item);
    if (!parsed || parsed.kind !== "custom") continue;
    if (seen.has(parsed.id) || isReservedHarnessId(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}

/** Empty title or instructions (after trim) fall back to Standard Harness copy for that field. */
export function assertCustomCatalogFits(list: readonly HarnessDefinition[]): void {
  if (list.length > MAX_CUSTOM_HARNESSES) {
    throw new Error(`At most ${MAX_CUSTOM_HARNESSES} custom Harnesses can be saved.`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(list)).length;
  if (bytes > MAX_CUSTOM_HARNESSES_BYTES) {
    throw new Error("Custom Harness catalog exceeds the storage ceiling.");
  }
}

export type HarnessDraft = {
  id?: string;
  name: string;
  description?: string;
  phases?: Partial<Record<Phase, Partial<PhaseSpec>>>;
};

export function validateHarnessDraft(draft: HarnessDraft): string | null {
  const name = draft.name.trim();
  if (name.length < 1 || name.length > 80) {
    return "Name must be 1–80 characters.";
  }
  const description = (draft.description ?? "").trim();
  if (description.length > 500) {
    return "Description must be at most 500 characters.";
  }
  if (draft.id) {
    if (!ID_PATTERN.test(draft.id) || isReservedHarnessId(draft.id)) {
      return "That Harness id is reserved or invalid.";
    }
  }
  if (draft.phases) {
    for (const phase of PHASES) {
      const spec = draft.phases[phase];
      if (!spec) continue;
      if (spec.title !== undefined && spec.title.trim().length > 200) {
        return `${phase} title must be at most 200 characters.`;
      }
      if (spec.detail !== undefined && spec.detail.trim().length > 4000) {
        return `${phase} instructions must be at most 4000 characters.`;
      }
    }
  }
  return null;
}

export function customHarnessId(name: string, unique: () => string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const base = slug || "custom";
  const suffix = unique().slice(0, 8);
  const id = `c-${base}-${suffix}`.slice(0, 48);
  return ID_PATTERN.test(id) ? id : `c-harness-${suffix}`;
}

export function cloneStandardHarness(
  draft: HarnessDraft,
  unique: () => string,
  now = Date.now(),
): HarnessDefinition {
  const error = validateHarnessDraft(draft);
  if (error) throw new Error(error);
  const standard = standardHarnessDefinition(now);
  const phases = { ...standard.phases };
  if (draft.phases) {
    for (const phase of PHASES) {
      const spec = draft.phases[phase];
      if (!spec) continue;
      phases[phase] = {
        title: spec.title?.trim() || phases[phase].title,
        detail: spec.detail?.trim() || phases[phase].detail,
      };
    }
  }
  return {
    id: draft.id && ID_PATTERN.test(draft.id) && !isReservedHarnessId(draft.id)
      ? draft.id
      : customHarnessId(draft.name, unique),
    name: draft.name.trim(),
    description: (draft.description ?? standard.description).trim(),
    kind: "custom",
    engine: "manual",
    phases,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyHarnessPatch(
  current: HarnessDefinition,
  draft: HarnessDraft,
  now = Date.now(),
): HarnessDefinition {
  if (current.kind !== "custom") {
    throw new Error("Built-in Harnesses are immutable.");
  }
  const error = validateHarnessDraft({ ...draft, id: current.id });
  if (error) throw new Error(error);
  const phases = { ...current.phases };
  if (draft.phases) {
    for (const phase of PHASES) {
      const spec = draft.phases[phase];
      if (!spec) continue;
      phases[phase] = {
        title: spec.title?.trim() || phases[phase].title,
        detail: spec.detail?.trim() || phases[phase].detail,
      };
    }
  }
  return {
    ...current,
    name: draft.name.trim(),
    description: draft.description !== undefined
      ? draft.description.trim()
      : current.description,
    phases,
    updatedAt: now,
  };
}

export function snapshotHarness(definition: HarnessDefinition): HarnessDefinition {
  return {
    ...definition,
    phases: {
      explore: { ...definition.phases.explore },
      plan: { ...definition.phases.plan },
      worker: { ...definition.phases.worker },
      critic: { ...definition.phases.critic },
      promote: { ...definition.phases.promote },
    },
  };
}

export function resolveHarnessId(input: {
  harnessId?: string | null;
  templateId?: string | null;
}): string {
  const explicit = input.harnessId?.trim();
  if (explicit === "milestone") return MILESTONE_PIPELINE_ID;
  if (explicit) return explicit;
  const legacy = input.templateId?.trim();
  if (legacy === "milestone") return MILESTONE_PIPELINE_ID;
  if (legacy) return legacy;
  return STANDARD_HARNESS_ID;
}

export function seedNodesFromDefinition(planId: string, definition: HarnessDefinition) {
  return seedArcNodes(planId, definition.phases);
}
