/**
 * v3 domain types — article-aligned Harness Arc.
 *
 * Pure module: no BB SDK imports. The arc is run lifecycle state; the DAG
 * contains implementation tasks only (no explore/plan/critic/promote nodes).
 */

export const V3_SCHEMA_VERSION = 3 as const;
export const TASK_PACKET_SCHEMA_VERSION = 1 as const;

export const V3_RUN_STATES = [
  "Setup",
  "Exploring",
  "Planning",
  "PlanApproval",
  "Executing",
  "WorkerReview",
  "Critiquing",
  "FinalReview",
  "Promoting",
  "Blocked",
  "Complete",
  "Cancelled",
] as const;
export type V3RunState = (typeof V3_RUN_STATES)[number];

export const V3_NODE_STATUSES = [
  "pending",
  "ready",
  "running",
  "awaiting_review",
  "done",
  "failed",
  "invalidated",
  "skipped",
] as const;
export type V3NodeStatus = (typeof V3_NODE_STATUSES)[number];

export const V3_ROLES = [
  "explorer",
  "planner",
  "workerFirst",
  "workerRest",
  "critic",
  "promoter",
] as const;
export type V3Role = (typeof V3_ROLES)[number];

export type V3ExecutionChoice = {
  providerId: string;
  model: string;
  reasoningLevel: string;
  serviceTier?: "default" | "fast";
  permissionMode?: "accept-edits" | "auto" | null;
};

export type V3RoleExecution = {
  choice: V3ExecutionChoice | null;
  permissionMode: "accept-edits" | "auto" | null;
  skillHints: string[];
};

export type V3RolePreset = {
  id: string;
  name: string;
  scope: "global" | "project";
  projectId: string | null;
  roles: Record<V3Role, V3RoleExecution>;
  promotionMode: "ask" | "off" | "always";
  artifactPolicy: "advisory" | "required";
};

export type V3WorkNode = {
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  expectedArtifacts: string[];
  skillHints: string[];
  status: V3NodeStatus;
  planRevision: number;
  attemptId: string | null;
  routingOverride: V3ExecutionChoice | null;
};

export type V3WorkNodeDraft = {
  title: string;
  objective: string;
  dependencies?: string[];
  acceptanceCriteria: string[];
  verificationCommands?: string[];
  expectedArtifacts?: string[];
  skillHints?: string[];
};

export type V3Decision = {
  id: string;
  kind:
    | "plan_approved"
    | "worker_accepted"
    | "worker_changes_requested"
    | "critic_approved"
    | "critic_rework"
    | "critic_blocked"
    | "promotion_started"
    | "promotion_skipped"
    | "run_cancelled"
    | "run_completed"
    | "exploration_accepted"
    | "exploration_skipped";
  actor: string;
  reason: string | null;
  nodeIds: string[];
  createdAt: number;
};

export type V3ArtifactRef = {
  path: string;
  kind:
    | "task-packet"
    | "exploration"
    | "plan"
    | "worker-report"
    | "critic"
    | "promotion"
    | "manifest"
    | "other";
  nodeId: string | null;
  createdAt: number;
};

export type V3VerificationResult = {
  command: string;
  exitCode: number | null;
  summary: string;
  nodeId: string | null;
  createdAt: number;
};

export type V3NodeResult = {
  nodeId: string;
  outcome: "complete" | "blocked" | "plan-change-needed";
  summary: string;
  changedFiles: string[];
  acceptanceResults: Array<{ criterion: string; met: boolean; note: string }>;
  commands: Array<{ command: string; exitCode: number | null; output: string }>;
  artifactRefs: string[];
  risks: string[];
  attemptId: string;
  createdAt: number;
};

export type V3ExplorationReport = {
  summary: string;
  findings: string[];
  suggestedNodes: V3WorkNodeDraft[];
  risks: string[];
  artifactRefs: string[];
  createdAt: number;
};

export type V3CriticReport = {
  recommendation: "APPROVE" | "REWORK" | "BLOCK";
  findings: Array<{ severity: "high" | "medium" | "low"; title: string; detail: string }>;
  affectedNodeIds: string[];
  checksRerun: Array<{ command: string; exitCode: number | null; note: string }>;
  unsupportedClaims: string[];
  risks: string[];
  createdAt: number;
};

export type V3PromotionReport = {
  audience: string;
  channel: string;
  summary: string;
  claims: string[];
  limitations: string[];
  artifactRefs: string[];
  createdAt: number;
};

export type V3TaskPacket = {
  schemaVersion: typeof TASK_PACKET_SCHEMA_VERSION;
  runId: string;
  packetVersion: number;
  objective: string;
  project: { id: string; name: string; environmentId: string; workspacePath: string };
  constraints: string[];
  exploration: V3ExplorationReport | null;
  approvedPlan: { revision: number; nodes: V3WorkNode[] } | null;
  currentNode: V3WorkNode | null;
  dependencyResults: V3NodeResult[];
  decisions: V3Decision[];
  artifactIndex: V3ArtifactRef[];
  verificationSummary: V3VerificationResult[];
};

export type V3RunRecord = {
  id: string;
  homeThreadId: string;
  projectId: string;
  environmentId: string | null;
  objective: string;
  state: V3RunState;
  revision: number;
  planRevision: number;
  draftRevision: number;
  plannerThreadId: string | null;
  explorerThreadId: string | null;
  criticThreadId: string | null;
  promoterThreadId: string | null;
  activeWorkerNodeId: string | null;
  activeWorkerThreadId: string | null;
  presetSnapshot: V3RolePreset;
  promotionChoice: "ask" | "off" | "always";
  evaluation: V3RunEvaluation | null;
  createdAt: number;
  updatedAt: number;
};

export type V3RunEvaluation = {
  outcome: "useful" | "neutral" | "costly" | null;
  reworkCount: number;
  acceptedAttempts: number;
  failedAttempts: number;
  elapsedMs: number | null;
  note: string | null;
};

export function isV3RunState(value: string): value is V3RunState {
  return (V3_RUN_STATES as readonly string[]).includes(value);
}

export function isV3NodeStatus(value: string): value is V3NodeStatus {
  return (V3_NODE_STATUSES as readonly string[]).includes(value);
}

export function isV3Role(value: string): value is V3Role {
  return (V3_ROLES as readonly string[]).includes(value);
}
