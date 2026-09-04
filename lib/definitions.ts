import {
  DEFAULT_EXECUTION,
  DEFAULT_PHASE_SPECS,
  PHASES,
  seedArcNodes,
  type ExecutionMode,
  type Phase,
  type PhaseSpec,
  isExecutionMode,
} from "./harness";
import {
  isArtifactPolicy,
  parseMaxCorrections,
  parsePromoteMode,
  type ArtifactPolicy,
  type PromoteMode,
} from "./outcomes";

export const STANDARD_HARNESS_ID = "standard";
export const REMOVED_MILESTONE_PIPELINE_ID = "milestone-pipeline";
export const CUSTOM_HARNESSES_KEY = "custom-harnesses";
export const MAX_CUSTOM_HARNESSES = 32;
export const MAX_CUSTOM_HARNESSES_BYTES = 200_000;
export const HARNESS_SCHEMA_VERSION = 2 as const;

export const HARNESS_ENGINES = ["manual"] as const;
export type HarnessEngine = (typeof HARNESS_ENGINES)[number];

export const HARNESS_KINDS = ["builtin", "custom"] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

export type HarnessDefinition = {
  id: string;
  name: string;
  description: string;
  kind: HarnessKind;
  engine: HarnessEngine;
  schemaVersion: typeof HARNESS_SCHEMA_VERSION;
  phases: Record<Phase, PhaseSpec>;
  artifactPolicy: ArtifactPolicy;
  promoteMode: PromoteMode;
  maxCorrections: number | null;
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

export function isRemovedHarnessId(id: string): boolean {
  return id === REMOVED_MILESTONE_PIPELINE_ID || id === "milestone";
}

export function isReservedHarnessId(id: string): boolean {
  return id === STANDARD_HARNESS_ID || isRemovedHarnessId(id);
}

export function removedHarnessError(id: string): string {
  return `Harness ${id} was removed. Milestone Pipeline is no longer available. Start Standard Harness or a custom Harness instead.`;
}

export function standardHarnessDefinition(now = 0): HarnessDefinition {
  return {
    id: STANDARD_HARNESS_ID,
    name: "Standard Harness",
    description:
      "Explore → Plan → Worker → Critic → Promote. Explore and Plan stay on the parent thread. Worker, Critic, and Promote spawn visible children. Critic records APPROVE, structured REWORK, or BLOCK. Promote communicates.",
    kind: "builtin",
    engine: "manual",
    schemaVersion: HARNESS_SCHEMA_VERSION,
    phases: {
      explore: { ...DEFAULT_PHASE_SPECS.explore, skills: [] },
      plan: { ...DEFAULT_PHASE_SPECS.plan, skills: [] },
      worker: { ...DEFAULT_PHASE_SPECS.worker, skills: [] },
      critic: { ...DEFAULT_PHASE_SPECS.critic, skills: [] },
      promote: { ...DEFAULT_PHASE_SPECS.promote, skills: [] },
    },
    artifactPolicy: "advisory",
    promoteMode: "always",
    maxCorrections: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function builtinHarnesses(now = 0): HarnessDefinition[] {
  return [standardHarnessDefinition(now)];
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

function parsePhaseSpec(phase: Phase, value: unknown): PhaseSpec | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.title !== "string" || typeof item.detail !== "string") return null;
  const title = item.title.trim() || DEFAULT_PHASE_SPECS[phase].title;
  const detail = item.detail.trim() || DEFAULT_PHASE_SPECS[phase].detail;
  if (title.length > 200) return null;
  if (detail.length > 4000) return null;
  const execution: ExecutionMode =
    typeof item.execution === "string" && isExecutionMode(item.execution)
      ? item.execution
      : DEFAULT_EXECUTION[phase];
  return { title, detail, execution, skills: [] };
}

function parsePhaseSpecs(value: unknown): Record<Phase, PhaseSpec> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const phases = { ...DEFAULT_PHASE_SPECS };
  for (const phase of PHASES) {
    const spec = parsePhaseSpec(phase, record[phase]);
    if (!spec) return null;
    phases[phase] = spec;
  }
  return phases;
}

function parseEngine(value: unknown): HarnessEngine | null {
  if (value === undefined || value === "manual") return "manual";
  return null;
}

export function parseHarnessDefinition(value: unknown): HarnessDefinition | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) return null;
  if (isRemovedHarnessId(record.id) && record.kind === "builtin") return null;
  if (typeof record.name !== "string") return null;
  const name = record.name.trim();
  if (name.length < 1 || name.length > 80) return null;
  if (typeof record.description !== "string") return null;
  const description = record.description.trim();
  if (description.length > 500) return null;
  if (typeof record.kind !== "string" || !isHarnessKind(record.kind)) return null;
  const engine = parseEngine(record.engine);
  if (!engine) return null;
  if (record.kind === "builtin" && !isReservedHarnessId(record.id) && record.id !== STANDARD_HARNESS_ID) {
    return null;
  }
  if (record.kind === "builtin" && record.id !== STANDARD_HARNESS_ID) return null;
  if (record.kind === "custom" && isReservedHarnessId(record.id)) return null;
  const phases = parsePhaseSpecs(record.phases);
  if (!phases) return null;
  const createdAt = typeof record.createdAt === "number" ? record.createdAt : 0;
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : createdAt;
  const artifactPolicy =
    typeof record.artifactPolicy === "string" && isArtifactPolicy(record.artifactPolicy)
      ? record.artifactPolicy
      : "advisory";
  const promoteMode = parsePromoteMode(record.promoteMode);
  const maxCorrections =
    record.maxCorrections === undefined ? null : parseMaxCorrections(record.maxCorrections);
  if (maxCorrections === undefined) return null;
  const schemaVersion =
    record.schemaVersion === 1 || record.schemaVersion === undefined
      ? HARNESS_SCHEMA_VERSION
      : record.schemaVersion === HARNESS_SCHEMA_VERSION
        ? HARNESS_SCHEMA_VERSION
        : null;
  if (schemaVersion == null) return null;
  return {
    id: record.id,
    name,
    description,
    kind: record.kind,
    engine,
    schemaVersion,
    phases,
    artifactPolicy,
    promoteMode,
    maxCorrections,
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
  artifactPolicy?: ArtifactPolicy;
  promoteMode?: PromoteMode;
  maxCorrections?: number | null;
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
  if (draft.maxCorrections !== undefined) {
    const parsed = parseMaxCorrections(draft.maxCorrections);
    if (parsed === undefined) return "maxCorrections must be an integer 0–99, or null.";
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
      if (spec.execution !== undefined && !isExecutionMode(spec.execution)) {
        return `${phase} execution must be parent or child.`;
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

function mergePhaseSpecs(
  base: Record<Phase, PhaseSpec>,
  patch?: Partial<Record<Phase, Partial<PhaseSpec>>>,
): Record<Phase, PhaseSpec> {
  const phases = {
    explore: { ...base.explore, skills: [...base.explore.skills] },
    plan: { ...base.plan, skills: [...base.plan.skills] },
    worker: { ...base.worker, skills: [...base.worker.skills] },
    critic: { ...base.critic, skills: [...base.critic.skills] },
    promote: { ...base.promote, skills: [...base.promote.skills] },
  };
  if (!patch) return phases;
  for (const phase of PHASES) {
    const spec = patch[phase];
    if (!spec) continue;
    phases[phase] = {
      title: spec.title?.trim() || phases[phase].title,
      detail: spec.detail?.trim() || phases[phase].detail,
      execution: spec.execution ?? phases[phase].execution,
      skills: [],
    };
  }
  return phases;
}

export function cloneStandardHarness(
  draft: HarnessDraft,
  unique: () => string,
  now = Date.now(),
): HarnessDefinition {
  const error = validateHarnessDraft(draft);
  if (error) throw new Error(error);
  const standard = standardHarnessDefinition(now);
  return {
    id: draft.id && ID_PATTERN.test(draft.id) && !isReservedHarnessId(draft.id)
      ? draft.id
      : customHarnessId(draft.name, unique),
    name: draft.name.trim(),
    description: (draft.description ?? standard.description).trim(),
    kind: "custom",
    engine: "manual",
    schemaVersion: HARNESS_SCHEMA_VERSION,
    phases: mergePhaseSpecs(standard.phases, draft.phases),
    artifactPolicy: draft.artifactPolicy ?? standard.artifactPolicy,
    promoteMode: draft.promoteMode !== undefined
      ? parsePromoteMode(draft.promoteMode)
      : standard.promoteMode,
    maxCorrections:
      draft.maxCorrections !== undefined ? draft.maxCorrections : standard.maxCorrections,
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
  return {
    ...current,
    name: draft.name.trim(),
    description: draft.description !== undefined
      ? draft.description.trim()
      : current.description,
    phases: mergePhaseSpecs(current.phases, draft.phases),
    artifactPolicy: draft.artifactPolicy ?? current.artifactPolicy,
    promoteMode: draft.promoteMode !== undefined
      ? parsePromoteMode(draft.promoteMode)
      : current.promoteMode,
    maxCorrections:
      draft.maxCorrections !== undefined ? draft.maxCorrections : current.maxCorrections,
    schemaVersion: HARNESS_SCHEMA_VERSION,
    updatedAt: now,
  };
}

export function snapshotHarness(definition: HarnessDefinition): HarnessDefinition {
  return {
    ...definition,
    schemaVersion: HARNESS_SCHEMA_VERSION,
    phases: {
      explore: { ...definition.phases.explore, skills: [...definition.phases.explore.skills] },
      plan: { ...definition.phases.plan, skills: [...definition.phases.plan.skills] },
      worker: { ...definition.phases.worker, skills: [...definition.phases.worker.skills] },
      critic: { ...definition.phases.critic, skills: [...definition.phases.critic.skills] },
      promote: { ...definition.phases.promote, skills: [...definition.phases.promote.skills] },
    },
  };
}

export function resolveHarnessId(input: {
  harnessId?: string | null;
  templateId?: string | null;
}): string {
  const explicit = input.harnessId?.trim();
  if (explicit) return explicit === "milestone" ? REMOVED_MILESTONE_PIPELINE_ID : explicit;
  const legacy = input.templateId?.trim();
  if (legacy) return legacy === "milestone" ? REMOVED_MILESTONE_PIPELINE_ID : legacy;
  return STANDARD_HARNESS_ID;
}

export function seedNodesFromDefinition(planId: string, definition: HarnessDefinition) {
  return seedArcNodes(planId, definition.phases).map((node) => ({
    ...node,
    status: node.phase === "promote" && definition.promoteMode === "off" ? "skipped" as const : undefined,
  }));
}
