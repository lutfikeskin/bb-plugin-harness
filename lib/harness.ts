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
    label: "Explore / Scout",
    hint: "Explore stays on the parent for Standard Harness. Milestone Scout/Specialist spawn children. Unset inherits the parent thread.",
  },
  plan: {
    label: "Plan / Planner",
    hint: "Plan stays on the parent for Standard Harness. Milestone Planner submits a packet for operator approval.",
  },
  workerFirst: {
    label: "Worker (first node)",
    hint: "First Worker child. On Milestone Pipeline this is Worker + Tester. Prewalk frontier.",
  },
  workerRest: {
    label: "Worker (later nodes)",
    hint: "Later Worker children, including Milestone's one-shot correction. Prewalk commodity.",
  },
  critic: {
    label: "Critic / Reviewer",
    hint: "Critic may rewind Worker. Milestone Reviewer returns APPROVE, CORRECTION_REQUIRED, or BLOCKED.",
  },
  promote: {
    label: "Promote",
    hint: "The job is unfinished until you communicate it. Spawns a child on Standard and Milestone.",
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

export function isSpawnablePhase(phase: Phase): boolean {
  return phase === "worker" || phase === "critic" || phase === "promote";
}

/** Every executable Harness run node, including Scout and Planner, is a visible child. */
export function isRunRoleSpawnable(_phase: Phase): boolean {
  return true;
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
    record.providerId.length === 0 ||
    typeof record.model !== "string" ||
    record.model.length === 0 ||
    typeof record.reasoningLevel !== "string" ||
    !isReasoningLevel(record.reasoningLevel)
  ) {
    return null;
  }
  const choice: ExecutionChoice = {
    providerId: record.providerId,
    model: record.model,
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

export type PhaseSpec = {
  title: string;
  detail: string;
};

export const DEFAULT_PHASE_SPECS: Record<Phase, PhaseSpec> = {
  explore: {
    title: "Explore the problem",
    detail: "Read the system. Isolate the real constraint. Do not implement yet.",
  },
  plan: {
    title: "Write the DAG",
    detail: "Name each node and its dependencies. One node, one outcome.",
  },
  worker: {
    title: "Implement the next node",
    detail: "Do one DAG node. Keep auditable output in artifacts/.",
  },
  critic: {
    title: "Critique and simplify",
    detail: "Question what shipped. Send work back if it does not hold.",
  },
  promote: {
    title: "Promote the result",
    detail: "Tell the people who need to know. A silent ship is unfinished.",
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
