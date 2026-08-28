export const PHASES = [
  "explore",
  "plan",
  "worker",
  "critic",
  "promote",
] as const;

export type Phase = (typeof PHASES)[number];

export const NODE_STATUSES = [
  "pending",
  "in_progress",
  "done",
  "skipped",
] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

export type ModelTier = "frontier" | "commodity";

export const ROUTING_SLOTS = [
  "explore",
  "plan",
  "workerFirst",
  "workerRest",
  "critic",
  "promote",
] as const;

export type RoutingSlot = (typeof ROUTING_SLOTS)[number];

export const ROUTING_SLOT_COPY: Record<
  RoutingSlot,
  { label: string; hint: string }
> = {
  explore: {
    label: "Explore",
    hint: "Explore stays on the parent for Standard Harness unless a custom definition sets child execution. Unset inherits the parent thread.",
  },
  plan: {
    label: "Plan",
    hint: "Plan stays on the parent for Standard Harness unless a custom definition sets child execution.",
  },
  workerFirst: {
    label: "Worker (first node)",
    hint: "First Worker child. Prewalk frontier.",
  },
  workerRest: {
    label: "Worker (later nodes)",
    hint: "Later Worker children. Prewalk commodity.",
  },
  critic: {
    label: "Critic",
    hint: "Critic may rewind Worker with APPROVE, REWORK, or BLOCK.",
  },
  promote: {
    label: "Promote",
    hint: "The job is unfinished until you communicate it. Spawns a child on Standard Harness.",
  },
};

export const REASONING_LEVELS = [
  "high",
  "low",
  "max",
  "medium",
  "none",
  "ultra",
  "ultracode",
  "xhigh",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type ExecutionChoice = {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier?: "default" | "fast";
};

export type RoleRouting = Record<RoutingSlot, ExecutionChoice | null>;

export function emptyRoleRouting(): RoleRouting {
  return {
    explore: null,
    plan: null,
    workerFirst: null,
    workerRest: null,
    critic: null,
    promote: null,
  };
}

export function routingSlotFor(phase: Phase, workerIndex: number): RoutingSlot {
  if (phase === "worker") return workerIndex <= 0 ? "workerFirst" : "workerRest";
  if (phase === "explore" || phase === "plan" || phase === "critic" || phase === "promote") {
    return phase;
  }
  return "workerRest";
}

export const EXECUTION_MODES = ["parent", "child"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export function isExecutionMode(value: string): value is ExecutionMode {
  return (EXECUTION_MODES as readonly string[]).includes(value);
}

export const DEFAULT_EXECUTION: Record<Phase, ExecutionMode> = {
  explore: "parent",
  plan: "parent",
  worker: "child",
  critic: "child",
  promote: "child",
};

export function isSpawnablePhase(phase: Phase): boolean {
  return DEFAULT_EXECUTION[phase] === "child";
}

export function nodeSpawnsChild(node: {
  phase: Phase;
  execution?: ExecutionMode;
}): boolean {
  return (node.execution ?? DEFAULT_EXECUTION[node.phase]) === "child";
}

export const PHASE_COPY: Record<
  Phase,
  { label: string; verb: string; summary: string }
> = {
  explore: {
    label: "Explore",
    verb: "Exploring",
    summary: "Map the problem, read the system, isolate the real constraint.",
  },
  plan: {
    label: "Plan",
    verb: "Planning",
    summary: "Turn exploration into an explicit DAG. Name each node and its dependencies.",
  },
  worker: {
    label: "Worker",
    verb: "Working",
    summary: "Implement the approved plan. Do not mix in critique.",
  },
  critic: {
    label: "Critic",
    verb: "Critiquing",
    summary: "Simplify, question, and send work back if it does not hold.",
  },
  promote: {
    label: "Promote",
    verb: "Promoting",
    summary: "The job is unfinished until you communicate it to others.",
  },
};

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

export function isNodeStatus(value: string): value is NodeStatus {
  return (NODE_STATUSES as readonly string[]).includes(value);
}

export function nextPhase(phase: Phase): Phase | null {
  const index = PHASES.indexOf(phase);
  return index >= 0 && index < PHASES.length - 1 ? PHASES[index + 1]! : null;
}

export function previousPhase(phase: Phase): Phase | null {
  const index = PHASES.indexOf(phase);
  return index > 0 ? PHASES[index - 1]! : null;
}

/** Prewalk: frontier for explore/plan, first worker node, critic, and promote. */
export function recommendedTier(args: {
  phase: Phase;
  workerIndex?: number;
  prewalkEnabled: boolean;
}): ModelTier {
  if (!args.prewalkEnabled) return "frontier";
  if (args.phase === "worker") {
    return args.workerIndex === 0 ? "frontier" : "commodity";
  }
  return "frontier";
}

export function isRoutingSlot(value: string): value is RoutingSlot {
  return (ROUTING_SLOTS as readonly string[]).includes(value);
}

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

export function parseExecutionChoice(value: unknown): ExecutionChoice | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.providerId !== "string" ||
    typeof record.model !== "string" ||
    typeof record.reasoningLevel !== "string" ||
    !isReasoningLevel(record.reasoningLevel)
  ) {
    return null;
  }
  const providerId = record.providerId.trim();
  const model = record.model.trim();
  if (providerId.length === 0 || model.length === 0) return null;
  const choice: ExecutionChoice = {
    providerId,
    model,
    reasoningLevel: record.reasoningLevel,
  };
  if (record.serviceTier === "default" || record.serviceTier === "fast") {
    choice.serviceTier = record.serviceTier;
  }
  return choice;
}

export function parseRoleRouting(value: unknown): RoleRouting {
  const base = emptyRoleRouting();
  if (!value || typeof value !== "object") return base;
  const record = value as Record<string, unknown>;
  for (const slot of ROUTING_SLOTS) {
    base[slot] = parseExecutionChoice(record[slot]);
  }
  return base;
}

export function formatChoice(choice: ExecutionChoice | null): string {
  if (!choice) return "inherit parent";
  const tier = choice.serviceTier ? ` ${choice.serviceTier}` : "";
  return `${choice.providerId}/${choice.model} (${choice.reasoningLevel}${tier})`;
}

export type PlanNode = {
  id: string;
  title: string;
  detail: string;
  phase: Phase;
  status: NodeStatus;
  deps: string[];
  sortOrder: number;
  childThreadId?: string | null;
  providerId?: string | null;
  model?: string | null;
  reasoningLevel?: string | null;
  serviceTier?: string | null;
  execution?: ExecutionMode;
  skills?: string[];
};

export function nodeChoice(node: PlanNode): ExecutionChoice | null {
  return parseExecutionChoice({
    providerId: node.providerId,
    model: node.model,
    reasoningLevel: node.reasoningLevel,
    serviceTier: node.serviceTier,
  });
}

export function parseDeps(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function wouldCycle(
  nodes: readonly PlanNode[],
  fromId: string,
  extraDeps: readonly string[],
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const node = byId.get(id);
    const deps = id === fromId ? extraDeps : (node?.deps ?? []);
    for (const dep of deps) {
      if (walk(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return walk(fromId);
}

export function readyNodes<T extends PlanNode>(nodes: readonly T[]): T[] {
  const done = new Set(
    nodes
      .filter((node) => node.status === "done" || node.status === "skipped")
      .map((node) => node.id),
  );
  return nodes
    .filter((node) => node.status === "pending")
    .filter((node) => node.deps.every((dep) => done.has(dep)))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function activeNode<T extends PlanNode>(nodes: readonly T[]): T | null {
  return nodes.find((node) => node.status === "in_progress") ?? null;
}

export function nextWorkNode<T extends PlanNode>(nodes: readonly T[]): T | null {
  return activeNode(nodes) ?? readyNodes(nodes)[0] ?? null;
}

export function workerOrdinal(nodes: readonly PlanNode[], nodeId: string): number {
  const workers = nodes
    .filter((node) => node.phase === "worker")
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return workers.findIndex((node) => node.id === nodeId);
}

export function routingChoiceForPlanNode(
  nodes: readonly PlanNode[],
  node: PlanNode,
  routing: RoleRouting,
): ExecutionChoice | null {
  const override = nodeChoice(node);
  if (override) return override;
  const ordinal = workerOrdinal(nodes, node.id);
  return routing[routingSlotFor(node.phase, ordinal >= 0 ? ordinal : 0)];
}

/** Exact id wins; otherwise a bare phase name aliases the seeded `{planId}-{phase}` node. */
export function resolveNodeRef(
  nodes: readonly Pick<PlanNode, "id" | "phase" | "sortOrder">[],
  requested: string,
  planId: string,
): string {
  if (nodes.some((node) => node.id === requested)) return requested;
  if (isPhase(requested)) {
    const seeded = seedNodeId(planId, requested);
    if (nodes.some((node) => node.id === seeded)) return seeded;
    const match = nodes
      .filter((node) => node.phase === requested)
      .sort((a, b) => a.sortOrder - b.sortOrder)[0];
    if (match) return match.id;
  }
  return requested;
}

export function resolveDependencyIds(
  nodes: readonly Pick<PlanNode, "id" | "phase" | "sortOrder">[],
  deps: readonly string[],
  planId: string,
): string[] {
  return deps.map((dep) => {
    const resolved = resolveNodeRef(nodes, dep, planId);
    if (!nodes.some((node) => node.id === resolved)) {
      throw new Error(`Unknown dependency ${dep}`);
    }
    return resolved;
  });
}

export function assertNewNodeDeps(
  nodes: readonly PlanNode[],
  node: Pick<PlanNode, "id" | "title" | "detail" | "phase" | "status" | "sortOrder"> & {
    deps: string[];
  },
): void {
  const known = new Set(nodes.map((item) => item.id));
  known.add(node.id);
  const unknown = node.deps.filter((dep) => !known.has(dep));
  if (unknown.length > 0) {
    throw new Error(`Unknown dependency ${unknown.join(", ")}`);
  }
  if (wouldCycle([...nodes, { ...node, deps: node.deps }], node.id, node.deps)) {
    throw new Error("That dependency list would create a cycle.");
  }
}

export function namespacedNodeId(
  planId: string,
  title: string,
  taken: ReadonlySet<string>,
  unique: () => string,
): string {
  const base = `${planId}-${slugId(title)}`;
  if (!taken.has(base)) return base;
  let id = `${base}-${unique()}`;
  while (taken.has(id)) id = `${base}-${unique()}`;
  return id;
}

export type PhaseSpec = {
  title: string;
  detail: string;
  execution: ExecutionMode;
  skills: string[];
};

export const DEFAULT_PHASE_SPECS: Record<Phase, PhaseSpec> = {
  explore: {
    title: "Explore the problem",
    detail: "Read the system. Isolate the real constraint. Do not implement yet.",
    execution: "parent",
    skills: [],
  },
  plan: {
    title: "Write the DAG",
    detail: "Name each node and its dependencies. One node, one outcome.",
    execution: "parent",
    skills: [],
  },
  worker: {
    title: "Implement the next node",
    detail: "Do one DAG node. Keep auditable output in artifacts/.",
    execution: "child",
    skills: [],
  },
  critic: {
    title: "Critique and simplify",
    detail: "Return APPROVE, REWORK, or BLOCK. Send work back if it does not hold.",
    execution: "child",
    skills: [],
  },
  promote: {
    title: "Promote the result",
    detail: "Tell the people who need to know. A silent ship is unfinished.",
    execution: "child",
    skills: [],
  },
};

export function seedNodeId(planId: string, phase: Phase): string {
  return `${planId}-${phase}`;
}

export function seedArcNodes(
  planId: string,
  phaseSpecs: Record<Phase, PhaseSpec> = DEFAULT_PHASE_SPECS,
): Array<Omit<PlanNode, "status" | "sortOrder"> & { sortOrder?: number }> {
  return PHASES.map((phase, index) => {
    const spec = phaseSpecs[phase] ?? DEFAULT_PHASE_SPECS[phase];
    const previous = index > 0 ? PHASES[index - 1]! : null;
    return {
      id: seedNodeId(planId, phase),
      title: spec.title,
      detail: spec.detail,
      phase,
      execution: spec.execution ?? DEFAULT_EXECUTION[phase],
      skills: [...(spec.skills ?? [])],
      deps: previous ? [seedNodeId(planId, previous)] : [],
    };
  });
}

export function slugId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || "node";
}
