import { z } from "zod";
import type { ExecutionChoice, Phase, RoleRouting } from "./harness";
import { parseRoleRouting, routingSlotFor } from "./harness";

export const PROMPT_VERSION = "harness-role-prompts@1";
export const SCHEMA_VERSION = "harness-packets@1";
export const MILESTONE_PIPELINE_ID = "milestone-pipeline";

export const LIVE_RUN_STATUSES = [
  "configuring",
  "running",
  "awaiting_plan_approval",
  "awaiting_correction_approval",
] as const;

export const TERMINAL_RUN_STATUSES = [
  "completed",
  "blocked",
  "cancelled",
  "failed",
] as const;

export const RUN_STATUSES = [
  ...LIVE_RUN_STATUSES,
  ...TERMINAL_RUN_STATUSES,
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_NODE_STATUSES = [
  "pending",
  "starting",
  "in_progress",
  "failed",
  "skipped",
  "done",
] as const;

export type RunNodeStatus = (typeof RUN_NODE_STATUSES)[number];

export const AGENT_ROLES = [
  "scout",
  "specialist",
  "planner",
  "worker",
  "reviewer",
  "promote",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export const PACKET_KINDS = [
  "scout_findings",
  "specialist_recommendation",
  "plan_packet",
  "work_report",
  "review_verdict",
  "promote_report",
] as const;

export type PacketKind = (typeof PACKET_KINDS)[number];

export const REVIEW_VERDICTS = [
  "APPROVE",
  "CORRECTION_REQUIRED",
  "BLOCKED",
] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const ROLE_PACKET_KIND: Record<AgentRole, PacketKind> = {
  scout: "scout_findings",
  specialist: "specialist_recommendation",
  planner: "plan_packet",
  worker: "work_report",
  reviewer: "review_verdict",
  promote: "promote_report",
};

export const ROLE_PHASE: Record<AgentRole, Phase> = {
  scout: "explore",
  specialist: "explore",
  planner: "plan",
  worker: "worker",
  reviewer: "critic",
  promote: "promote",
};

export const ROLE_TITLE: Record<AgentRole, string> = {
  scout: "Scout",
  specialist: "Specialist",
  planner: "Planner",
  worker: "Worker + Tester",
  reviewer: "Reviewer",
  promote: "Promote",
};

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

export function isLiveRunStatus(value: string): boolean {
  return (LIVE_RUN_STATUSES as readonly string[]).includes(value);
}

export function isTerminalRunStatus(value: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(value);
}

export function isRunNodeStatus(value: string): value is RunNodeStatus {
  return (RUN_NODE_STATUSES as readonly string[]).includes(value);
}

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

export function isPacketKind(value: string): value is PacketKind {
  return (PACKET_KINDS as readonly string[]).includes(value);
}

export const scoutFindingsSchema = z.object({
  summary: z.string().trim().min(1).max(8000),
  findings: z.array(z.string().trim().min(1).max(2000)).max(50).default([]),
  risks: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
  recommendedNext: z.string().trim().max(2000).optional(),
});

export const specialistRecommendationSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  recommendation: z.string().trim().min(1).max(8000),
  confidence: z.string().trim().max(200).optional(),
});

/** Planner work-item notes. v1 does not materialize these into run DAG nodes. */
export const planPacketSchema = z.object({
  summary: z.string().trim().min(1).max(8000),
  nodes: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(80),
        title: z.string().trim().min(1).max(200),
        detail: z.string().max(2000).optional(),
        deps: z.array(z.string().trim().min(1)).max(32).optional(),
      }),
    )
    .max(64)
    .default([]),
  notes: z.string().trim().max(8000).optional(),
});

export const workReportSchema = z.object({
  summary: z.string().trim().min(1).max(8000),
  changedPaths: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
  tests: z
    .object({
      ran: z.boolean(),
      result: z.enum(["pass", "fail", "not_run"]).default("not_run"),
      notes: z.string().trim().max(4000).optional(),
    })
    .optional(),
  followUps: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
});

export const reviewVerdictSchema = z
  .object({
    verdict: z.enum(REVIEW_VERDICTS),
    summary: z.string().trim().min(1).max(8000),
    issues: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
    correctionRequest: z.string().trim().max(8000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.verdict === "CORRECTION_REQUIRED" && !value.correctionRequest?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "CORRECTION_REQUIRED requires correctionRequest",
        path: ["correctionRequest"],
      });
    }
  });

export const promoteReportSchema = z.object({
  summary: z.string().trim().min(1).max(8000),
  audience: z.string().trim().max(500).optional(),
  remainingRisks: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
});

export const PACKET_SCHEMAS: Record<PacketKind, z.ZodType> = {
  scout_findings: scoutFindingsSchema,
  specialist_recommendation: specialistRecommendationSchema,
  plan_packet: planPacketSchema,
  work_report: workReportSchema,
  review_verdict: reviewVerdictSchema,
  promote_report: promoteReportSchema,
};

export type TaskPacket = {
  objective: string;
  branch: string | null;
  execPlanPath: string | null;
  protectedPaths: string[];
  runScout: boolean;
  specialistQuestion: string | null;
  routingOverrides: RoleRouting | null;
  projectId: string;
  parentThreadId: string;
  environmentId: string | null;
  promptVersion: string;
  schemaVersion: string;
};

export type RunTemplateNode = {
  key: string;
  role: AgentRole;
  phase: Phase;
  title: string;
  detail: string;
  deps: string[];
  optional: boolean;
  skip: boolean;
};

export type HarnessRunNode = {
  id: string;
  runId: string;
  templateNodeKey: string;
  role: AgentRole;
  phase: Phase;
  ordinal: number;
  status: RunNodeStatus;
  deps: string[];
  childThreadId: string | null;
  providerId: string | null;
  model: string | null;
  reasoningLevel: string | null;
  serviceTier: string | null;
  startedAt: number | null;
  completedAt: number | null;
  packetVersion: number;
};

export type HarnessRun = {
  id: string;
  projectId: string;
  parentThreadId: string;
  templateId: string;
  status: RunStatus;
  currentStageId: string | null;
  taskPacket: TaskPacket;
  correctionCount: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type TransitionIntent =
  | { type: "start_node"; templateNodeKey: string }
  | { type: "await_plan_approval" }
  | { type: "await_correction_approval" }
  | { type: "complete" }
  | { type: "blocked"; reason: string }
  | { type: "idle" };

export function milestonePipelineNodes(input: {
  runScout: boolean;
  specialistQuestion: string | null;
}): RunTemplateNode[] {
  const specialist = Boolean(input.specialistQuestion?.trim());
  return [
    {
      key: "scout",
      role: "scout",
      phase: "explore",
      title: "Scout",
      detail: "Map the problem. Do not implement.",
      deps: [],
      optional: true,
      skip: !input.runScout,
    },
    {
      key: "specialist",
      role: "specialist",
      phase: "explore",
      title: "Specialist",
      detail: "Answer one exceptional-risk question.",
      deps: ["scout"],
      optional: true,
      skip: !specialist,
    },
    {
      key: "planner",
      role: "planner",
      phase: "plan",
      title: "Planner",
      detail: "Freeze the plan packet. v1 always continues to one fixed Worker + Tester node.",
      deps: ["scout", "specialist"],
      optional: false,
      skip: false,
    },
    {
      key: "worker",
      role: "worker",
      phase: "worker",
      title: "Worker + Tester",
      detail: "Implement the approved plan as one bounded unit of work and test it.",
      deps: ["planner"],
      optional: false,
      skip: false,
    },
    {
      key: "reviewer",
      role: "reviewer",
      phase: "critic",
      title: "Reviewer",
      detail: "Independently review. Return APPROVE, CORRECTION_REQUIRED, or BLOCKED.",
      deps: ["worker"],
      optional: false,
      skip: false,
    },
    {
      key: "promote",
      role: "promote",
      phase: "promote",
      title: "Promote",
      detail: "Report the result. Do not start follow-up work.",
      deps: ["reviewer"],
      optional: false,
      skip: false,
    },
  ];
}

export function correctionNodes(): RunTemplateNode[] {
  return [
    {
      key: "worker_correction",
      role: "worker",
      phase: "worker",
      title: "Correction Worker + Tester",
      detail: "Apply one bounded correction pass. Do not expand scope.",
      deps: ["reviewer"],
      optional: false,
      skip: false,
    },
    {
      key: "reviewer_final",
      role: "reviewer",
      phase: "critic",
      title: "Final Reviewer",
      detail: "Final review after one correction. APPROVE or BLOCKED only; no further loop.",
      deps: ["worker_correction"],
      optional: false,
      skip: false,
    },
  ];
}

export function parseTaskPacket(value: unknown): TaskPacket | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.objective !== "string" || record.objective.trim().length === 0) {
    return null;
  }
  const protectedPaths = Array.isArray(record.protectedPaths)
    ? record.protectedPaths.filter((item): item is string => typeof item === "string")
    : [];
  return {
    objective: record.objective.trim(),
    branch: typeof record.branch === "string" && record.branch.trim() ? record.branch.trim() : null,
    execPlanPath:
      typeof record.execPlanPath === "string" && record.execPlanPath.trim()
        ? record.execPlanPath.trim()
        : null,
    protectedPaths,
    runScout: record.runScout !== false,
    specialistQuestion:
      typeof record.specialistQuestion === "string" && record.specialistQuestion.trim()
        ? record.specialistQuestion.trim()
        : null,
    routingOverrides: record.routingOverrides
      ? parseRoleRouting(record.routingOverrides)
      : null,
    projectId: typeof record.projectId === "string" ? record.projectId : "",
    parentThreadId: typeof record.parentThreadId === "string" ? record.parentThreadId : "",
    environmentId:
      typeof record.environmentId === "string" && record.environmentId
        ? record.environmentId
        : null,
    promptVersion:
      typeof record.promptVersion === "string" ? record.promptVersion : PROMPT_VERSION,
    schemaVersion:
      typeof record.schemaVersion === "string" ? record.schemaVersion : SCHEMA_VERSION,
  };
}

export function validateRolePacket(
  role: AgentRole,
  kind: string,
  payload: unknown,
): { ok: true; kind: PacketKind; payload: unknown } | { ok: false; error: string } {
  const expected = ROLE_PACKET_KIND[role];
  if (kind !== expected) {
    return {
      ok: false,
      error: `Role ${role} must submit packet kind ${expected}, not ${kind}`,
    };
  }
  const parsed = PACKET_SCHEMAS[expected].safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }
  return { ok: true, kind: expected, payload: parsed.data };
}

export function satisfiedKeys(nodes: readonly HarnessRunNode[]): Set<string> {
  return new Set(
    nodes
      .filter((node) => node.status === "done" || node.status === "skipped")
      .map((node) => node.templateNodeKey),
  );
}

export function activeRunNode(nodes: readonly HarnessRunNode[]): HarnessRunNode | null {
  return (
    nodes.find((node) => node.status === "in_progress" || node.status === "starting") ?? null
  );
}

export function readyRunNodes(nodes: readonly HarnessRunNode[]): HarnessRunNode[] {
  const done = satisfiedKeys(nodes);
  return nodes
    .filter((node) => node.status === "pending")
    .filter((node) => node.deps.every((dep) => done.has(dep)))
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function firstReadyNode(nodes: readonly HarnessRunNode[]): HarnessRunNode | null {
  return readyRunNodes(nodes)[0] ?? null;
}

export function workerOrdinalForRun(
  nodes: readonly HarnessRunNode[],
  nodeId: string,
): number {
  const workers = nodes
    .filter((node) => node.role === "worker")
    .sort((a, b) => a.ordinal - b.ordinal);
  return workers.findIndex((node) => node.id === nodeId);
}

export function routingSlotForRunNode(
  nodes: readonly HarnessRunNode[],
  node: HarnessRunNode,
) {
  return routingSlotFor(node.phase, Math.max(0, workerOrdinalForRun(nodes, node.id)));
}

export function nodeOverrideChoice(node: HarnessRunNode): ExecutionChoice | null {
  if (
    !node.providerId ||
    !node.model ||
    !node.reasoningLevel
  ) {
    return null;
  }
  const choice: ExecutionChoice = {
    providerId: node.providerId,
    model: node.model,
    reasoningLevel: node.reasoningLevel as ExecutionChoice["reasoningLevel"],
  };
  if (node.serviceTier === "default" || node.serviceTier === "fast") {
    choice.serviceTier = node.serviceTier;
  }
  return choice;
}

export function applyNodeRouting(
  node: HarnessRunNode,
  choice: ExecutionChoice | null,
): void {
  if (!choice) {
    node.providerId = null;
    node.model = null;
    node.reasoningLevel = null;
    node.serviceTier = null;
    return;
  }
  node.providerId = choice.providerId;
  node.model = choice.model;
  node.reasoningLevel = choice.reasoningLevel;
  node.serviceTier = choice.serviceTier ?? null;
}

export function readReviewVerdict(payload: unknown): ReviewVerdict | null {
  if (!payload || typeof payload !== "object") return null;
  const verdict = (payload as { verdict?: unknown }).verdict;
  if (verdict === "APPROVE" || verdict === "CORRECTION_REQUIRED" || verdict === "BLOCKED") {
    return verdict;
  }
  return null;
}

export function intentAfterPacket(args: {
  run: HarnessRun;
  nodes: readonly HarnessRunNode[];
  completed: HarnessRunNode;
  payload: unknown;
}): TransitionIntent {
  const { run, nodes, completed, payload } = args;
  if (completed.role === "planner") {
    return { type: "await_plan_approval" };
  }
  if (completed.role === "promote") {
    return { type: "complete" };
  }
  if (completed.role === "reviewer") {
    const verdict = readReviewVerdict(payload);
    if (verdict === "APPROVE") {
      const next = firstReadyNode(nodes);
      if (!next) return { type: "blocked", reason: "Reviewer approved but no Promote node is ready." };
      return { type: "start_node", templateNodeKey: next.templateNodeKey };
    }
    if (verdict === "BLOCKED") {
      return { type: "blocked", reason: "Reviewer returned BLOCKED." };
    }
    if (verdict === "CORRECTION_REQUIRED") {
      if (completed.templateNodeKey === "reviewer_final" || run.correctionCount >= 1) {
        return {
          type: "blocked",
          reason: "Final review cannot loop; correction budget is exhausted.",
        };
      }
      return { type: "await_correction_approval" };
    }
    return { type: "blocked", reason: "Reviewer packet is missing a verdict." };
  }
  const next = firstReadyNode(nodes);
  if (!next) return { type: "idle" };
  return { type: "start_node", templateNodeKey: next.templateNodeKey };
}

export function canApprovePlan(run: HarnessRun): boolean {
  return run.status === "awaiting_plan_approval";
}

export function canApproveCorrection(run: HarnessRun): boolean {
  return run.status === "awaiting_correction_approval" && run.correctionCount < 1;
}

export function canRetryNode(run: HarnessRun, node: HarnessRunNode): boolean {
  return isLiveRunStatus(run.status) && node.status === "failed";
}

export function canStopRun(run: HarnessRun): boolean {
  return isLiveRunStatus(run.status);
}

export function roleContract(role: AgentRole): string {
  switch (role) {
    case "scout":
      return "Map the problem. Read AGENTS.md and the selected ExecPlan. Do not implement. Submit one scout_findings packet, then stop.";
    case "specialist":
      return "Answer only the Specialist question. Do not expand scope. Submit one specialist_recommendation packet, then stop.";
    case "planner":
      return "Turn findings into an explicit plan packet. Do not implement. Submit one plan_packet, then stop. The optional nodes list is operator context only; v1 always runs one fixed Worker + Tester node after approval.";
    case "worker":
      return "Implement the assigned work. Test it. Do not mix in critique. Submit one work_report packet, then stop.";
    case "reviewer":
      return "Independently review. Return APPROVE, CORRECTION_REQUIRED, or BLOCKED. At most one correction exists for the run. Submit one review_verdict packet, then stop.";
    case "promote":
      return "Report what changed, why it matters, verification, risks, and the next milestone. Do not start follow-up work. Submit one promote_report packet, then stop.";
  }
}

export function buildRolePrompt(args: {
  role: AgentRole;
  node: Pick<HarnessRunNode, "id" | "templateNodeKey">;
  taskPacket: TaskPacket;
  priorPackets: Array<{ kind: PacketKind; role: AgentRole; payload: unknown }>;
}): string {
  const { role, node, taskPacket, priorPackets } = args;
  const packetJson = JSON.stringify(
    {
      objective: taskPacket.objective,
      branch: taskPacket.branch,
      execPlanPath: taskPacket.execPlanPath,
      protectedPaths: taskPacket.protectedPaths,
      runScout: taskPacket.runScout,
      specialistQuestion: taskPacket.specialistQuestion,
      projectId: taskPacket.projectId,
      parentThreadId: taskPacket.parentThreadId,
      environmentId: taskPacket.environmentId,
      promptVersion: taskPacket.promptVersion,
      schemaVersion: taskPacket.schemaVersion,
    },
    null,
    2,
  );
  const prior = priorPackets.length
    ? JSON.stringify(priorPackets, null, 2)
    : "(none)";
  return [
    `You are the ${ROLE_TITLE[role]} for one Harness run node.`,
    roleContract(role),
    "Work this role only. Do not plan, implement, and critique in the same pass.",
    "Keep auditable outputs in artifacts/.",
    "Read AGENTS.md and the selected active ExecPlan when a path is provided.",
    "Do not push, merge, deploy, or change production authority.",
    "Do not embed secrets or raw document contents in logs.",
    "Submit exactly one result with harness_submit_result, then stop.",
    `Packet kind: ${ROLE_PACKET_KIND[role]}`,
    `Node id: ${node.id}`,
    `Template key: ${node.templateNodeKey}`,
    `Title: ${ROLE_TITLE[role]} (${node.templateNodeKey})`,
    "",
    "Frozen Task Packet:",
    packetJson,
    "",
    "Prior packets:",
    prior,
  ].join("\n");
}

export function priorPacketsForRole(
  role: AgentRole,
  packets: Array<{ kind: PacketKind; role: AgentRole; payload: unknown; templateNodeKey: string }>,
): Array<{ kind: PacketKind; role: AgentRole; payload: unknown }> {
  const needed = new Set<AgentRole>();
  if (role === "specialist" || role === "planner") needed.add("scout");
  if (role === "planner") needed.add("specialist");
  if (role === "worker") {
    needed.add("scout");
    needed.add("specialist");
    needed.add("planner");
    needed.add("reviewer");
  }
  if (role === "reviewer") {
    needed.add("planner");
    needed.add("worker");
  }
  if (role === "promote") {
    needed.add("planner");
    needed.add("worker");
    needed.add("reviewer");
  }
  return packets
    .filter((packet) => needed.has(packet.role))
    .map(({ kind, role: packetRole, payload }) => ({ kind, role: packetRole, payload }));
}

export function participantInstruction(role: AgentRole | "operator"): string {
  if (role === "operator") {
    return "Harness run is active. Work this phase only. Do not plan, implement, and critique in the same pass. Keep auditable outputs in artifacts/. Role children submit one structured packet and stop.";
  }
  return `Harness arc role: ${ROLE_TITLE[role]}. ${roleContract(role)}`;
}
