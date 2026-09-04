// bb-plugin-harness — five-phase arc + DAG plans for BB threads.
//
// Explore → Plan → Worker → Critic → Promote. Spawn uses snapshotted execution
// mode. Role routing is stored in plugin KV. Historical Milestone tables remain.
//
// Threat model: BB plugins are full-trust in-process code. Plugin RPC has no
// authenticated caller distinct from the local user. These checks exist to make
// accidental/stale cross-project or child-thread plan mutation impossible, not
// to defend against a malicious local plugin. RPC is not a tenant security
// boundary.
import { createHash, randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  V3_MIGRATIONS,
  readThreadOutput,
  registerV3Backend,
  submitPlanDraftFromTool,
  validateCriticReport,
  validateExplorationReport,
  validatePromotionReport,
  validateWorkerReport,
  v3RpcContract,
} from "./lib/v3-backend";
import { validateV3Draft } from "./lib/v3/dag";
import { artifactDirForRun, generateWorkerMarkdown, isSafeV3ArtifactRef } from "./lib/v3/artifacts";
import {
  PHASES,
  PHASE_COPY,
  REASONING_LEVELS,
  ROUTING_SLOTS,
  activeNode,
  defaultRoleRouting,
  emptyRoleRouting,
  formatChoice,
  isPhase,
  isNodeStatus,
  isRoutingSlot,
  nextWorkNode,
  nodeChoice,
  nodeSpawnsChild,
  parseDeps,
  parseRoleRouting,
  recommendedTier,
  resolveDependencyIds,
  resolveNodeRef,
  namespacedNodeId,
  assertNewNodeDeps,
  routingSlotFor,
  workerOrdinal,
  type ExecutionChoice,
  type ExecutionMode,
  type Phase,
  type PlanNode,
  type RoleRouting,
} from "./lib/harness";
import {
  CUSTOM_HARNESSES_KEY,
  HARNESS_SCHEMA_VERSION,
  REMOVED_MILESTONE_PIPELINE_ID,
  STANDARD_HARNESS_ID,
  applyHarnessPatch,
  assertCustomCatalogFits,
  builtinHarnesses,
  cloneStandardHarness,
  isRemovedHarnessId,
  isReservedHarnessId,
  parseCustomHarnesses,
  parseHarnessDefinition,
  removedHarnessError,
  resolveHarnessId,
  snapshotHarness,
  seedNodesFromDefinition,
  standardHarnessDefinition,
  toHarnessRef,
  type HarnessDefinition,
} from "./lib/definitions";
import {
  ARTIFACT_POLICIES,
  CRITIC_VERDICTS,
  MAX_ARTIFACT_PATH_LENGTH,
  MAX_ARTIFACT_PATHS,
  MAX_CORRECTIONS,
  MAX_RESULT_SUMMARY,
  PLUGIN_SKILL_NAME,
  PROMOTE_MODES,
  addTokenCounters,
  artifactDirForPlan,
  artifactManifestPath,
  canRework,
  durationMs,
  emptyTokenCounters,
  parseArtifactPaths,
  parseTokenUsageEvent,
  type CriticVerdict,
  type TokenCounters,
} from "./lib/outcomes";

const REALTIME_CHANNEL = "harness";
const HISTORICAL_LIVE_RUN =
  "('configuring','running','awaiting_plan_approval','awaiting_correction_approval')";

const phaseSchema = z.enum(PHASES);
const nodeStatusSchema = z.enum(["pending", "starting", "in_progress", "done", "skipped"]);
const executionModeSchema = z.enum(["parent", "child"]);
const criticVerdictSchema = z.enum(CRITIC_VERDICTS);
const planLifecycleSchema = z.enum(["active", "completed", "cancelled", "superseded", "archived"]);
const attemptOutcomeSchema = z.enum([
  "running",
  "idle_with_output",
  "idle_empty",
  "failed",
  "interrupted",
  "stopped",
]);

const arcSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  phase: phaseSchema,
  note: z.string(),
  updatedAt: z.number(),
});

const reasoningLevelSchema = z.enum(REASONING_LEVELS);
const executionChoiceSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningLevel: reasoningLevelSchema,
  serviceTier: z.enum(["default", "fast"]).optional(),
});
const roleRoutingSchema = z.object({
  explore: executionChoiceSchema.nullable(),
  plan: executionChoiceSchema.nullable(),
  workerFirst: executionChoiceSchema.nullable(),
  workerRest: executionChoiceSchema.nullable(),
  critic: executionChoiceSchema.nullable(),
  promote: executionChoiceSchema.nullable(),
});
const childThreadSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  providerId: z.string(),
});
const tokenCountersSchema = z.object({
  input: z.number().nullable(),
  cached: z.number().nullable(),
  output: z.number().nullable(),
  reasoning: z.number().nullable(),
  total: z.number().nullable(),
});
const nodeResultSchema = z.object({
  verdict: criticVerdictSchema.nullable(),
  summary: z.string().nullable(),
  artifactPaths: z.array(z.string()),
  actor: z.string(),
  source: z.string(),
  attemptId: z.string().nullable(),
  childThreadId: z.string().nullable(),
  outputHash: z.string(),
  requestId: z.string(),
  expectedRevision: z.number(),
  createdAt: z.number(),
});
const nodeAttemptSchema = z.object({
  id: z.string(),
  childThreadId: z.string().nullable(),
  executionThreadId: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  tokens: tokenCountersSchema,
  source: z.string(),
  outcome: attemptOutcomeSchema,
  outputHash: z.string().nullable(),
});
const planNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  phase: phaseSchema,
  status: nodeStatusSchema,
  deps: z.array(z.string()),
  sortOrder: z.number(),
  childThreadId: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  serviceTier: z.string().nullable(),
  execution: executionModeSchema,
  skills: z.array(z.string()),
  revision: z.number(),
  child: childThreadSchema.nullable(),
  result: nodeResultSchema.nullable(),
  attempt: nodeAttemptSchema.nullable(),
  attempts: z.array(nodeAttemptSchema),
});

const phaseSpecSchema = z.object({
  title: z.string(),
  detail: z.string(),
  execution: executionModeSchema,
  skills: z.array(z.string()),
});
const harnessDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(["builtin", "custom"]),
  engine: z.enum(["manual"]),
  schemaVersion: z.literal(HARNESS_SCHEMA_VERSION),
  phases: z.object({
    explore: phaseSpecSchema,
    plan: phaseSpecSchema,
    worker: phaseSpecSchema,
    critic: phaseSpecSchema,
    promote: phaseSpecSchema,
  }),
  artifactPolicy: z.enum(ARTIFACT_POLICIES),
  promoteMode: z.enum(PROMOTE_MODES),
  maxCorrections: z.number().int().min(0).max(MAX_CORRECTIONS).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const harnessRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(["builtin", "custom"]),
  engine: z.enum(["manual"]),
});
const harnessDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  phases: z
    .object({
      explore: phaseSpecSchema.partial().optional(),
      plan: phaseSpecSchema.partial().optional(),
      worker: phaseSpecSchema.partial().optional(),
      critic: phaseSpecSchema.partial().optional(),
      promote: phaseSpecSchema.partial().optional(),
    })
    .optional(),
  artifactPolicy: z.enum(ARTIFACT_POLICIES).optional(),
  promoteMode: z.preprocess(
    (value) => (value === "ask" ? "always" : value),
    z.enum(PROMOTE_MODES).optional(),
  ),
  maxCorrections: z.number().int().min(0).max(MAX_CORRECTIONS).nullable().optional(),
});

const planMetaSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  threadId: z.string().nullable(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nodeCount: z.number(),
  doneCount: z.number(),
  harnessId: z.string().nullable(),
  correctionCount: z.number(),
  criticBlocked: z.boolean(),
  lifecycle: planLifecycleSchema,
  revision: z.number(),
});

const planTotalsSchema = z.object({
  durationMs: z.number().nullable(),
  tokens: tokenCountersSchema,
});

const mutationSchema = z.object({
  id: z.string(),
  nodeId: z.string().nullable(),
  action: z.string(),
  actor: z.string(),
  source: z.string(),
  requestId: z.string(),
  reason: z.string().nullable(),
  expectedRevision: z.number().nullable(),
  resultingRevision: z.number(),
  attemptId: z.string().nullable(),
  childThreadId: z.string().nullable(),
  outputHash: z.string().nullable(),
  createdAt: z.number(),
});

const planFullSchema = planMetaSchema.extend({
  nodes: z.array(planNodeSchema),
  harnessSnapshot: harnessDefinitionSchema.nullable(),
  totals: planTotalsSchema,
  skillWarnings: z.array(z.string()),
  mutations: z.array(mutationSchema),
});

export type ArcDto = z.infer<typeof arcSchema>;
export type PlanNodeDto = z.infer<typeof planNodeSchema>;
export type PlanMetaDto = z.infer<typeof planMetaSchema>;
export type PlanFullDto = z.infer<typeof planFullSchema>;

const statusSchema = z.object({
  arc: arcSchema,
  plan: planFullSchema.nullable(),
  nextNode: planNodeSchema.nullable(),
  tier: z.enum(["frontier", "commodity"]),
  commodityModel: z.string(),
  frontierModel: z.string(),
  prewalkEnabled: z.boolean(),
  routing: roleRoutingSchema,
  harness: harnessRefSchema.nullable(),
  customHarnesses: z.array(harnessDefinitionSchema),
});

export type HarnessStatusDto = z.infer<typeof statusSchema>;

const startRunInputSchema = z.object({
  threadId: z.string(),
  projectId: z.string().optional(),
  objective: z.string().trim().min(1).max(8000),
  harnessId: z.string().trim().min(1).max(64).optional(),
  templateId: z.string().trim().min(1).max(64).optional(),
});

const completeNodeInputSchema = z.object({
  planId: z.string(),
  nodeId: z.string(),
  threadId: z.string(),
  projectId: z.string().optional(),
  verdict: criticVerdictSchema.optional(),
  summary: z.string().trim().max(MAX_RESULT_SUMMARY).optional(),
  artifactPaths: z.array(z.string().trim().min(1).max(MAX_ARTIFACT_PATH_LENGTH)).max(MAX_ARTIFACT_PATHS).optional(),
  expectedRevision: z.number().int().nonnegative(),
  expectedAttemptId: z.string().nullable().optional(),
  requestId: z.string().trim().min(1).max(100),
});
const planAccessSchema = z.object({
  threadId: z.string(),
  projectId: z.string().optional(),
});

export const rpcContract = defineRpcContract({
  getStatus: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
    }),
    output: statusSchema,
  },
  setPhase: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
      phase: phaseSchema,
      note: z.string().max(500).optional(),
      reason: z.string().trim().min(1).max(500),
      expectedRevision: z.number().int().nonnegative(),
      requestId: z.string().trim().min(1).max(100),
    }),
    output: statusSchema,
  },
  advance: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
    }),
    output: statusSchema,
  },
  rewind: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
    }),
    output: statusSchema,
  },
  listPlans: {
    input: z.object({
      projectId: z.string(),
      threadId: z.string().optional(),
    }),
    output: z.object({ plans: z.array(planMetaSchema) }),
  },
  getPlan: {
    input: z.object({ id: z.string() }).merge(planAccessSchema),
    output: z.object({ plan: planFullSchema.nullable() }),
  },
  createPlan: {
    input: z.object({
      projectId: z.string().optional(),
      threadId: z.string(),
      name: z.string().trim().min(1).max(200),
      seedArc: z.boolean().optional(),
    }),
    output: z.object({ plan: planFullSchema }),
  },
  addNode: {
    input: z.object({
      planId: z.string(),
      title: z.string().trim().min(1).max(200),
      detail: z.string().max(2000).optional(),
      phase: phaseSchema.optional(),
      deps: z.array(z.string()).optional(),
      expectedRevision: z.number().int().nonnegative(),
      requestId: z.string().trim().min(1).max(100),
    }).merge(planAccessSchema),
    output: z.object({ plan: planFullSchema }),
  },
  startNode: {
    input: z.object({
      planId: z.string(),
      nodeId: z.string(),
      expectedRevision: z.number().int().nonnegative(),
      requestId: z.string().trim().min(1).max(100),
    }).merge(planAccessSchema),
    output: z.object({ plan: planFullSchema }),
  },
  getRouting: {
    input: z.object({}),
    output: z.object({ routing: roleRoutingSchema }),
  },
  setRouting: {
    input: z.object({
      slot: z.enum(ROUTING_SLOTS),
      choice: executionChoiceSchema.nullable(),
    }),
    output: z.object({ routing: roleRoutingSchema }),
  },
  setNodeRouting: {
    input: z.object({
      planId: z.string(),
      nodeId: z.string(),
      choice: executionChoiceSchema.nullable(),
      expectedRevision: z.number().int().nonnegative(),
      requestId: z.string().trim().min(1).max(100),
    }).merge(planAccessSchema),
    output: z.object({ plan: planFullSchema }),
  },
  suggestChoice: {
    input: z.object({}),
    output: z.object({ choice: executionChoiceSchema }),
  },
  completeNode: {
    input: completeNodeInputSchema,
    output: z.object({ plan: planFullSchema }),
  },
  skipNode: {
    input: z.object({
      planId: z.string(), nodeId: z.string(), expectedRevision: z.number().int().nonnegative(),
      requestId: z.string().trim().min(1).max(100), reason: z.string().trim().min(1).max(500),
    }).merge(planAccessSchema),
    output: z.object({ plan: planFullSchema }),
  },
  reopenNode: {
    input: z.object({
      planId: z.string(), nodeId: z.string(), expectedRevision: z.number().int().nonnegative(),
      requestId: z.string().trim().min(1).max(100), reason: z.string().trim().min(1).max(500),
      recovery: z.literal(true),
    }).merge(planAccessSchema),
    output: z.object({ plan: planFullSchema }),
  },
  resetCriticBlock: {
    input: z.object({
      planId: z.string(), expectedRevision: z.number().int().nonnegative(),
      requestId: z.string().trim().min(1).max(100), reason: z.string().trim().min(1).max(500),
    }).merge(planAccessSchema),
    output: z.object({ plan: planFullSchema }),
  },
  initWorkspace: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
    }),
    output: z.object({
      path: z.string(),
      written: z.array(z.string()),
      skipped: z.array(z.string()),
    }),
  },
  startRun: {
    input: startRunInputSchema,
    output: statusSchema,
  },
  stopRun: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
      expectedRevision: z.number().int().nonnegative(),
      requestId: z.string().trim().min(1).max(100),
      reason: z.string().trim().min(1).max(500),
    }),
    output: statusSchema,
  },
  listHarnesses: {
    input: z.object({}),
    output: z.object({ harnesses: z.array(harnessDefinitionSchema) }),
  },
  createHarness: {
    input: harnessDraftSchema,
    output: z.object({ harness: harnessDefinitionSchema }),
  },
  updateHarness: {
    input: harnessDraftSchema.extend({ id: z.string().trim().min(1).max(64) }),
    output: z.object({ harness: harnessDefinitionSchema }),
  },
  deleteHarness: {
    input: z.object({ id: z.string().trim().min(1).max(64) }),
    output: z.object({ ok: z.literal(true) }),
  },
});

type ArcRow = {
  thread_id: string;
  project_id: string;
  phase: string;
  note: string;
  updated_at: number;
  harness_id: string | null;
  plan_id: string | null;
};

type PlanRow = {
  id: string;
  project_id: string;
  thread_id: string | null;
  name: string;
  created_at: number;
  updated_at: number;
  harness_id: string | null;
  harness_snapshot: string | null;
  correction_count: number;
  critic_blocked: number;
  lifecycle: "active" | "completed" | "cancelled" | "superseded" | "archived";
  revision: number;
};

type NodeRow = {
  id: string;
  plan_id: string;
  title: string;
  detail: string;
  phase: string;
  status: string;
  deps: string;
  sort_order: number;
  child_thread_id: string | null;
  provider_id: string | null;
  model: string | null;
  reasoning_level: string | null;
  service_tier: string | null;
  execution: string | null;
  skills: string | null;
  revision: number;
};

type ResultRow = {
  id: string;
  plan_id: string;
  node_id: string;
  verdict: string | null;
  summary: string | null;
  artifact_paths: string;
  actor: string;
  source: string;
  attempt_id: string | null;
  child_thread_id: string | null;
  output_hash: string;
  request_id: string;
  expected_revision: number;
  created_at: number;
};

type MutationRow = {
  id: string;
  plan_id: string;
  node_id: string | null;
  action: string;
  actor: string;
  source: string;
  request_id: string;
  reason: string | null;
  expected_revision: number | null;
  resulting_revision: number;
  attempt_id: string | null;
  child_thread_id: string | null;
  output_hash: string | null;
  created_at: number;
};

type AttemptRow = {
  id: string;
  plan_id: string;
  node_id: string;
  child_thread_id: string | null;
  execution_thread_id: string | null;
  provider_id: string | null;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  tokens_input: number | null;
  tokens_cached: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_total: number | null;
  source: string;
  outcome: "running" | "idle_with_output" | "idle_empty" | "failed" | "interrupted" | "stopped";
  output_hash: string | null;
  created_at: number;
};

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function parseSkillsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toNode(row: NodeRow): PlanNode {
  const phase = isPhase(row.phase) ? row.phase : "worker";
  const execution =
    row.execution === "parent" || row.execution === "child"
      ? (row.execution as ExecutionMode)
      : undefined;
  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    phase,
    status: isNodeStatus(row.status) ? row.status : "pending",
    deps: parseDeps(row.deps),
    sortOrder: row.sort_order,
    childThreadId: row.child_thread_id ?? null,
    providerId: row.provider_id ?? null,
    model: row.model ?? null,
    reasoningLevel: row.reasoning_level ?? null,
    serviceTier: row.service_tier ?? null,
    execution,
    skills: parseSkillsJson(row.skills),
    revision: row.revision ?? 0,
  };
}

function tokensFromAttempt(row: AttemptRow): TokenCounters {
  return {
    input: row.tokens_input,
    cached: row.tokens_cached,
    output: row.tokens_output,
    reasoning: row.tokens_reasoning,
    total: row.tokens_total,
  };
}

function usage(): string {
  return [
    "Usage (v3 Harness for BB):",
    "  bb harness status [--thread <id>] [--json]",
    "  bb harness start --task <text> [--preset <id>] [--thread <id>] [--json]",
    "  bb harness approve-plan [--thread <id>] [--json]",
    "  bb harness review-worker <node-id> --approve|--changes <text> [--json]",
    "  bb harness review-critic --approve|--rework <node-ids> --reason <text>|--block <text> [--json]",
    "  bb harness promote --start|--skip [--json]",
    "  bb harness cancel --reason <text> [--json]",
    "  bb harness export [--thread <id>] [--json]",
    "  bb harness preset list|show|create|update|delete ...",
    "  bb harness legacy list|show|cancel ...  (read-only legacy v0.1/v2)",
    "Legacy (deprecated, read-compatible, never mutates v3):",
    "  bb harness set-phase <phase> --reason <text> [--thread <id>] [--json]  # recovery",
    "  bb harness stop [--reason <text>] [--thread <id>] [--json]",
    "  bb harness plan list|show|create|add|next|start|complete|reopen|reset-block ...",
    "  bb harness routing [show|set|clear] ...",
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  db.pragma("foreign_keys = ON");
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS arcs (
       thread_id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       phase TEXT NOT NULL,
       note TEXT NOT NULL DEFAULT '',
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS plans (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       thread_id TEXT,
       name TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS plan_nodes (
       id TEXT PRIMARY KEY,
       plan_id TEXT NOT NULL,
       title TEXT NOT NULL,
       detail TEXT NOT NULL DEFAULT '',
       phase TEXT NOT NULL,
       status TEXT NOT NULL,
       deps TEXT NOT NULL DEFAULT '[]',
       sort_order INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS plans_project_idx ON plans(project_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS plan_nodes_plan_idx ON plan_nodes(plan_id, sort_order)`,
    `ALTER TABLE plan_nodes ADD COLUMN child_thread_id TEXT`,
    `ALTER TABLE plan_nodes ADD COLUMN provider_id TEXT`,
    `ALTER TABLE plan_nodes ADD COLUMN model TEXT`,
    `ALTER TABLE plan_nodes ADD COLUMN reasoning_level TEXT`,
    `ALTER TABLE plan_nodes ADD COLUMN service_tier TEXT`,
    `CREATE INDEX IF NOT EXISTS plan_nodes_child_idx ON plan_nodes(child_thread_id)`,
    `CREATE TABLE IF NOT EXISTS harness_runs (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       parent_thread_id TEXT NOT NULL,
       template_id TEXT NOT NULL,
       status TEXT NOT NULL,
       current_stage_id TEXT,
       task_packet_json TEXT NOT NULL,
       correction_count INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       completed_at INTEGER
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS harness_runs_one_live
       ON harness_runs(parent_thread_id)
       WHERE status IN ('configuring','running','awaiting_plan_approval','awaiting_correction_approval')`,
    `CREATE INDEX IF NOT EXISTS harness_runs_parent_idx
       ON harness_runs(parent_thread_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS harness_run_nodes (
       id TEXT PRIMARY KEY,
       run_id TEXT NOT NULL,
       template_node_key TEXT NOT NULL,
       role TEXT NOT NULL,
       phase TEXT NOT NULL,
       ordinal INTEGER NOT NULL,
       status TEXT NOT NULL,
       deps TEXT NOT NULL DEFAULT '[]',
       child_thread_id TEXT,
       provider_id TEXT,
       model TEXT,
       reasoning_level TEXT,
       service_tier TEXT,
       started_at INTEGER,
       completed_at INTEGER,
       packet_version INTEGER NOT NULL DEFAULT 1,
       FOREIGN KEY(run_id) REFERENCES harness_runs(id) ON DELETE CASCADE,
       UNIQUE(run_id, template_node_key)
     )`,
    `CREATE INDEX IF NOT EXISTS harness_run_nodes_run_idx
       ON harness_run_nodes(run_id, ordinal)`,
    `CREATE INDEX IF NOT EXISTS harness_run_nodes_child_idx
       ON harness_run_nodes(child_thread_id)`,
    `CREATE TABLE IF NOT EXISTS harness_packets (
       id TEXT PRIMARY KEY,
       run_id TEXT NOT NULL,
       run_node_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       version INTEGER NOT NULL,
       payload_json TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       FOREIGN KEY(run_id) REFERENCES harness_runs(id) ON DELETE CASCADE,
       FOREIGN KEY(run_node_id) REFERENCES harness_run_nodes(id) ON DELETE CASCADE,
       UNIQUE(run_node_id, version)
     )`,
    `CREATE INDEX IF NOT EXISTS harness_packets_run_idx ON harness_packets(run_id, created_at)`,
    `ALTER TABLE plans ADD COLUMN harness_id TEXT`,
    `ALTER TABLE plans ADD COLUMN harness_snapshot TEXT`,
    `ALTER TABLE arcs ADD COLUMN harness_id TEXT`,
    `ALTER TABLE plan_nodes ADD COLUMN execution TEXT`,
    `ALTER TABLE plan_nodes ADD COLUMN skills TEXT`,
    `ALTER TABLE plans ADD COLUMN correction_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE plans ADD COLUMN critic_blocked INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS plan_node_results (
       id TEXT PRIMARY KEY,
       plan_id TEXT NOT NULL,
       node_id TEXT NOT NULL,
       verdict TEXT,
       summary TEXT,
       artifact_paths TEXT NOT NULL DEFAULT '[]',
       actor TEXT NOT NULL,
       source TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS plan_node_results_node_idx
       ON plan_node_results(plan_id, node_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS harness_artifacts (
       id TEXT PRIMARY KEY,
       plan_id TEXT NOT NULL,
       node_id TEXT,
       path TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS harness_artifacts_plan_idx ON harness_artifacts(plan_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS plan_node_attempts (
       id TEXT PRIMARY KEY,
       plan_id TEXT NOT NULL,
       node_id TEXT NOT NULL,
       child_thread_id TEXT,
       provider_id TEXT,
       model TEXT,
       started_at INTEGER,
       ended_at INTEGER,
       duration_ms INTEGER,
       tokens_input INTEGER,
       tokens_cached INTEGER,
       tokens_output INTEGER,
       tokens_reasoning INTEGER,
       tokens_total INTEGER,
       source TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS plan_node_attempts_node_idx
       ON plan_node_attempts(plan_id, node_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS plan_node_attempts_child_idx ON plan_node_attempts(child_thread_id)`,
    `ALTER TABLE arcs ADD COLUMN plan_id TEXT`,
    `ALTER TABLE plans ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'archived'`,
    `ALTER TABLE plans ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE plan_nodes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE plan_node_results ADD COLUMN attempt_id TEXT`,
    `ALTER TABLE plan_node_results ADD COLUMN child_thread_id TEXT`,
    `ALTER TABLE plan_node_results ADD COLUMN output_hash TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE plan_node_results ADD COLUMN request_id TEXT NOT NULL DEFAULT 'legacy'`,
    `ALTER TABLE plan_node_results ADD COLUMN expected_revision INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE plan_node_attempts ADD COLUMN outcome TEXT NOT NULL DEFAULT 'interrupted'`,
    `ALTER TABLE plan_node_attempts ADD COLUMN output_hash TEXT`,
    `UPDATE plans SET lifecycle = 'active'
       WHERE id IN (SELECT plan_id FROM arcs WHERE plan_id IS NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS plans_one_active_per_thread
       ON plans(thread_id) WHERE lifecycle = 'active' AND thread_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS plan_mutations (
       id TEXT PRIMARY KEY,
       plan_id TEXT NOT NULL,
       node_id TEXT,
       action TEXT NOT NULL,
       actor TEXT NOT NULL,
       source TEXT NOT NULL,
       request_id TEXT NOT NULL,
       reason TEXT,
       expected_revision INTEGER,
       resulting_revision INTEGER NOT NULL,
       attempt_id TEXT,
       child_thread_id TEXT,
       output_hash TEXT,
       detail_json TEXT NOT NULL DEFAULT '{}',
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS plan_mutations_plan_idx
       ON plan_mutations(plan_id, created_at)`,
    `UPDATE plans
       SET lifecycle = 'completed'
       WHERE lifecycle = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM plan_nodes
           WHERE plan_nodes.plan_id = plans.id
             AND status NOT IN ('done','skipped')
         )`,
    `DELETE FROM arcs
       WHERE plan_id IN (SELECT id FROM plans WHERE lifecycle = 'completed')`,
    `ALTER TABLE plan_node_attempts ADD COLUMN execution_thread_id TEXT`,
    `UPDATE plan_node_attempts SET execution_thread_id = child_thread_id WHERE execution_thread_id IS NULL`,
    `CREATE INDEX IF NOT EXISTS plan_node_attempts_execution_idx ON plan_node_attempts(execution_thread_id)`,
    ...V3_MIGRATIONS,
  ]);
  // Append-only migrate can skip a shifted ALTER; add the column if it is still missing.
  const arcColumns = db.prepare("PRAGMA table_info(arcs)").all() as Array<{ name: string }>;
  if (!arcColumns.some((column) => column.name === "plan_id")) {
    db.exec("ALTER TABLE arcs ADD COLUMN plan_id TEXT");
  }

  const settings = bb.settings.define({
    frontierModel: {
      type: "string",
      label: "Frontier model label",
      default: "frontier",
    },
    commodityModel: {
      type: "string",
      label: "Commodity model label",
      default: "commodity",
    },
    prewalkEnabled: {
      type: "boolean",
      label: "Prewalk (frontier for plan + first worker + critic/promote)",
      default: true,
    },
  });
  let currentSettings = await settings.get();
  settings.onChange((next) => {
    currentSettings = next;
  });

  const selectArc = db.prepare("SELECT * FROM arcs WHERE thread_id = ?");
  const insertArc = db.prepare(
    `INSERT INTO arcs (thread_id, project_id, phase, note, updated_at, harness_id, plan_id)
     VALUES (@thread_id, @project_id, @phase, @note, @updated_at, @harness_id, @plan_id)`,
  );
  const upsertArc = db.prepare(
    `INSERT INTO arcs (thread_id, project_id, phase, note, updated_at, harness_id, plan_id)
     VALUES (@thread_id, @project_id, @phase, @note, @updated_at, @harness_id, @plan_id)
     ON CONFLICT(thread_id) DO UPDATE SET
       project_id = excluded.project_id,
       phase = excluded.phase,
       note = excluded.note,
       updated_at = excluded.updated_at,
       harness_id = excluded.harness_id`,
  );
  const bindArcPlanId = db.prepare(
    `UPDATE arcs SET plan_id = ? WHERE thread_id = ? AND plan_id IS NULL`,
  );
  const deleteArc = db.prepare("DELETE FROM arcs WHERE thread_id = ?");
  const selectPlan = db.prepare("SELECT * FROM plans WHERE id = ?");
  const selectPlans = db.prepare(
    `SELECT * FROM plans WHERE project_id = ?
     ORDER BY updated_at DESC`,
  );
  const selectPlansForThread = db.prepare(
    `SELECT * FROM plans WHERE project_id = ? AND thread_id = ?
     ORDER BY updated_at DESC`,
  );
  const selectActivePlansForThread = db.prepare(
    `SELECT * FROM plans WHERE project_id = ? AND thread_id = ? AND lifecycle = 'active'
     ORDER BY updated_at DESC`,
  );
  const insertPlan = db.prepare(
    `INSERT INTO plans (id, project_id, thread_id, name, created_at, updated_at, harness_id, harness_snapshot, correction_count, critic_blocked, lifecycle, revision)
     VALUES (@id, @project_id, @thread_id, @name, @created_at, @updated_at, @harness_id, @harness_snapshot, @correction_count, @critic_blocked, @lifecycle, @revision)`,
  );
  const touchPlan = db.prepare(
    "UPDATE plans SET updated_at = ?, revision = revision + 1 WHERE id = ?",
  );
  const setPlanLifecycle = db.prepare(
    "UPDATE plans SET lifecycle = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
  );
  const updatePlanSnapshot = db.prepare(
    "UPDATE plans SET harness_id = ?, harness_snapshot = ?, updated_at = ? WHERE id = ?",
  );
  const updatePlanFlags = db.prepare(
    "UPDATE plans SET correction_count = ?, critic_blocked = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
  );
  const selectNodes = db.prepare(
    "SELECT * FROM plan_nodes WHERE plan_id = ? ORDER BY sort_order ASC",
  );
  const insertNode = db.prepare(
    `INSERT INTO plan_nodes (id, plan_id, title, detail, phase, status, deps, sort_order, execution, skills)
     VALUES (@id, @plan_id, @title, @detail, @phase, @status, @deps, @sort_order, @execution, @skills)`,
  );
  const updateNodeStatus = db.prepare(
    "UPDATE plan_nodes SET status = ?, revision = revision + 1 WHERE id = ? AND plan_id = ?",
  );
  const claimNodeStatus = db.prepare(
    "UPDATE plan_nodes SET status = ?, revision = revision + 1 WHERE id = ? AND plan_id = ? AND status = ?",
  );
  const recoverStartingNode = db.prepare(
    `UPDATE plan_nodes
     SET status = 'pending', revision = revision + 1
     WHERE id = ? AND plan_id = ? AND status = 'starting' AND child_thread_id IS NULL`,
  );
  const attachStartingChild = db.prepare(
    `UPDATE plan_nodes
     SET status = 'in_progress', child_thread_id = ?, revision = revision + 1
     WHERE id = ? AND plan_id = ? AND status = 'starting'`,
  );
  const casFailedChild = db.prepare(
    `UPDATE plan_nodes
     SET status = 'pending', child_thread_id = NULL, revision = revision + 1
     WHERE id = ? AND plan_id = ? AND status = 'in_progress' AND child_thread_id = ?`,
  );
  const selectNodeByChild = db.prepare(
    "SELECT * FROM plan_nodes WHERE child_thread_id = ?",
  );
  const updateNodeChoice = db.prepare(
    `UPDATE plan_nodes
     SET provider_id = ?, model = ?, reasoning_level = ?, service_tier = ?, revision = revision + 1
     WHERE id = ? AND plan_id = ?`,
  );
  const resetPlanNode = db.prepare(
    `UPDATE plan_nodes
     SET status = ?, child_thread_id = NULL, revision = revision + 1
     WHERE id = ? AND plan_id = ?`,
  );
  const selectAllNodeIds = db.prepare("SELECT id FROM plan_nodes");
  const insertResult = db.prepare(
    `INSERT INTO plan_node_results (
       id, plan_id, node_id, verdict, summary, artifact_paths, actor, source,
       attempt_id, child_thread_id, output_hash, request_id, expected_revision, created_at
     ) VALUES (
       @id, @plan_id, @node_id, @verdict, @summary, @artifact_paths, @actor, @source,
       @attempt_id, @child_thread_id, @output_hash, @request_id, @expected_revision, @created_at
     )`,
  );
  const selectResultsForPlan = db.prepare(
    `SELECT * FROM plan_node_results WHERE plan_id = ? ORDER BY created_at ASC`,
  );
  const insertArtifact = db.prepare(
    `INSERT INTO harness_artifacts (id, plan_id, node_id, path, created_at)
     VALUES (@id, @plan_id, @node_id, @path, @created_at)`,
  );
  const insertAttempt = db.prepare(
    `INSERT INTO plan_node_attempts (
       id, plan_id, node_id, child_thread_id, execution_thread_id, provider_id, model, started_at, ended_at,
       duration_ms, tokens_input, tokens_cached, tokens_output, tokens_reasoning, tokens_total,
       source, outcome, output_hash, created_at
     ) VALUES (
       @id, @plan_id, @node_id, @child_thread_id, @execution_thread_id, @provider_id, @model, @started_at, @ended_at,
       @duration_ms, @tokens_input, @tokens_cached, @tokens_output, @tokens_reasoning, @tokens_total,
       @source, @outcome, @output_hash, @created_at
     )`,
  );
  const updateAttempt = db.prepare(
    `UPDATE plan_node_attempts
     SET ended_at = @ended_at, duration_ms = @duration_ms,
         tokens_input = @tokens_input, tokens_cached = @tokens_cached,
         tokens_output = @tokens_output, tokens_reasoning = @tokens_reasoning,
         tokens_total = @tokens_total, outcome = @outcome,
         output_hash = COALESCE(@output_hash, output_hash)
     WHERE id = @id`,
  );
  const selectAttemptsForPlan = db.prepare(
    "SELECT * FROM plan_node_attempts WHERE plan_id = ? ORDER BY created_at ASC",
  );
  const selectOpenAttemptByChild = db.prepare(
    "SELECT * FROM plan_node_attempts WHERE child_thread_id = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1",
  );
  const selectOpenAttemptByExecution = db.prepare(
    "SELECT * FROM plan_node_attempts WHERE execution_thread_id = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1",
  );
  const selectOpenAttemptForNode = db.prepare(
    "SELECT * FROM plan_node_attempts WHERE plan_id = ? AND node_id = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1",
  );
  const selectLatestAttemptForNode = db.prepare(
    "SELECT * FROM plan_node_attempts WHERE plan_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1",
  );
  const setAttemptEvidence = db.prepare(
    `UPDATE plan_node_attempts
     SET outcome = 'idle_with_output', output_hash = ?, ended_at = COALESCE(ended_at, ?),
         duration_ms = COALESCE(duration_ms, CASE WHEN started_at IS NULL THEN NULL ELSE ? - started_at END)
     WHERE id = ? AND outcome IN ('running', 'idle_empty')`,
  );
  const selectMutationsForPlan = db.prepare(
    "SELECT * FROM plan_mutations WHERE plan_id = ? ORDER BY created_at DESC LIMIT 100",
  );
  const insertMutation = db.prepare(
    `INSERT INTO plan_mutations (
       id, plan_id, node_id, action, actor, source, request_id, reason,
       expected_revision, resulting_revision, attempt_id, child_thread_id,
       output_hash, detail_json, created_at
     ) VALUES (
       @id, @plan_id, @node_id, @action, @actor, @source, @request_id, @reason,
       @expected_revision, @resulting_revision, @attempt_id, @child_thread_id,
       @output_hash, @detail_json, @created_at
     )`,
  );
  const selectHistoricalLiveRun = db.prepare(
    `SELECT * FROM harness_runs
     WHERE parent_thread_id = ?
       AND status IN ${HISTORICAL_LIVE_RUN}
     ORDER BY created_at DESC LIMIT 1`,
  );
  const selectHistoricalRunNodeByChild = db.prepare(
    "SELECT * FROM harness_run_nodes WHERE child_thread_id = ?",
  );
  const cancelHistoricalRun = db.prepare(
    `UPDATE harness_runs SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?`,
  );
  const failHistoricalRunNode = db.prepare(
    `UPDATE harness_run_nodes SET status = 'failed', completed_at = ? WHERE run_id = ? AND status IN ('in_progress','starting')`,
  );
  const selectHistoricalRunNodes = db.prepare(
    "SELECT child_thread_id FROM harness_run_nodes WHERE run_id = ?",
  );

  const ROUTING_KEY = "routing";
  const storedRouting = await bb.storage.kv.get(ROUTING_KEY);
  // Seed role defaults once for installs that never saved routing. Saved
  // slots (including explicit null for inherit) are preserved as-is.
  let currentRouting: RoleRouting =
    storedRouting == null ? defaultRoleRouting() : parseRoleRouting(storedRouting);
  let customHarnesses: HarnessDefinition[] = parseCustomHarnesses(
    await bb.storage.kv.get(CUSTOM_HARNESSES_KEY),
  );

  async function saveRouting(next: RoleRouting): Promise<RoleRouting> {
    currentRouting = next;
    await bb.storage.kv.set(ROUTING_KEY, next);
    publish();
    return next;
  }

  async function saveCustomHarnesses(
    next: HarnessDefinition[],
  ): Promise<HarnessDefinition[]> {
    assertCustomCatalogFits(next);
    await bb.storage.kv.set(CUSTOM_HARNESSES_KEY, next);
    customHarnesses = next;
    publish();
    return next;
  }

  function catalogHarnesses(): HarnessDefinition[] {
    return [...builtinHarnesses(), ...customHarnesses];
  }

  function findHarness(id: string, snapshot?: HarnessDefinition | null): HarnessDefinition | null {
    const fromCatalog = catalogHarnesses().find((item) => item.id === id);
    if (fromCatalog) return fromCatalog;
    if (snapshot && snapshot.id === id) return snapshot;
    return null;
  }

  function requireHarness(id: string): HarnessDefinition {
    if (isRemovedHarnessId(id) || id === REMOVED_MILESTONE_PIPELINE_ID) {
      throw new Error(removedHarnessError(id));
    }
    const found = findHarness(id);
    if (!found) throw new Error(`Unknown Harness ${id}.`);
    return found;
  }

  function publish(): void {
    bb.realtime.publish(REALTIME_CHANNEL, { at: Date.now() });
  }

  function nodesOf(planId: string): PlanNode[] {
    return (selectNodes.all(planId) as NodeRow[]).map(toNode);
  }

  function snapshotOf(row: PlanRow): HarnessDefinition | null {
    if (!row.harness_snapshot) return null;
    try {
      return parseHarnessDefinition(JSON.parse(row.harness_snapshot));
    } catch {
      return null;
    }
  }

  function correctionCountOf(row: PlanRow): number {
    return typeof row.correction_count === "number" ? row.correction_count : 0;
  }

  function criticBlockedOf(row: PlanRow): boolean {
    return row.critic_blocked === 1;
  }

  function toMeta(row: PlanRow, nodes = nodesOf(row.id)) {
    return {
      id: row.id,
      projectId: row.project_id,
      threadId: row.thread_id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nodeCount: nodes.length,
      doneCount: nodes.filter((node) => node.status === "done").length,
      harnessId: row.harness_id ?? null,
      correctionCount: correctionCountOf(row),
      criticBlocked: criticBlockedOf(row),
      lifecycle: row.lifecycle ?? "archived",
      revision: row.revision ?? 0,
    };
  }

  function resultDto(row: ResultRow | undefined) {
    if (!row) return null;
    return {
      verdict: (row.verdict as CriticVerdict | null) ?? null,
      summary: row.summary,
      artifactPaths: parseDeps(row.artifact_paths),
      actor: row.actor,
      source: row.source,
      attemptId: row.attempt_id ?? null,
      childThreadId: row.child_thread_id ?? null,
      outputHash: row.output_hash || "legacy-unknown",
      requestId: row.request_id || "legacy",
      expectedRevision: row.expected_revision ?? 0,
      createdAt: row.created_at,
    };
  }

  function attemptDto(row: AttemptRow | undefined) {
    if (!row) return null;
    return {
      id: row.id,
      childThreadId: row.child_thread_id,
      executionThreadId: row.execution_thread_id ?? row.child_thread_id,
      providerId: row.provider_id,
      model: row.model,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      tokens: tokensFromAttempt(row),
      source: row.source,
      outcome: row.outcome ?? "interrupted",
      outputHash: row.output_hash ?? null,
    };
  }

  function planTotals(planId: string) {
    const attempts = selectAttemptsForPlan.all(planId) as AttemptRow[];
    let duration: number | null = null;
    let tokens = emptyTokenCounters();
    for (const attempt of attempts) {
      tokens = addTokenCounters(tokens, tokensFromAttempt(attempt));
      if (attempt.duration_ms != null) {
        duration = (duration ?? 0) + attempt.duration_ms;
      }
    }
    return { durationMs: duration, tokens };
  }

  async function enrichNodes(
    planId: string,
    nodes: PlanNode[],
  ): Promise<z.infer<typeof planNodeSchema>[]> {
    const attemptsByNode = new Map<string, AttemptRow[]>();
    for (const item of selectAttemptsForPlan.all(planId) as AttemptRow[]) {
      const list = attemptsByNode.get(item.node_id) ?? [];
      list.push(item);
      attemptsByNode.set(item.node_id, list);
    }
    const latestResults = new Map<string, ResultRow>();
    for (const item of selectResultsForPlan.all(planId) as ResultRow[]) {
      latestResults.set(item.node_id, item);
    }
    return Promise.all(
      nodes.map(async (node) => {
        const base = {
          id: node.id,
          title: node.title,
          detail: node.detail,
          phase: node.phase,
          status: node.status,
          deps: node.deps,
          sortOrder: node.sortOrder,
          childThreadId: node.childThreadId ?? null,
          providerId: node.providerId ?? null,
          model: node.model ?? null,
          reasoningLevel: node.reasoningLevel ?? null,
          serviceTier: node.serviceTier ?? null,
          execution: (node.execution ?? (nodeSpawnsChild(node) ? "child" : "parent")) as ExecutionMode,
          skills: node.skills ?? [],
          revision: node.revision ?? 0,
          child: null as z.infer<typeof childThreadSchema> | null,
          result: resultDto(latestResults.get(node.id)),
          attempt: attemptDto((attemptsByNode.get(node.id) ?? []).at(-1)),
          attempts: (attemptsByNode.get(node.id) ?? []).map((row) => attemptDto(row)!),
        };
        if (!node.childThreadId) return base;
        try {
          const thread = await bb.sdk.threads.get({ threadId: node.childThreadId });
          return {
            ...base,
            child: {
              id: thread.id,
              title: thread.title ?? thread.titleFallback,
              status: thread.status,
              providerId: thread.providerId,
            },
          };
        } catch {
          return {
            ...base,
            child: {
              id: node.childThreadId,
              title: null,
              status: "missing",
              providerId: "",
            },
          };
        }
      }),
    );
  }

  async function toFull(row: PlanRow) {
    const nodes = nodesOf(row.id);
    const snapshot = snapshotOf(row);
    const mutations = (selectMutationsForPlan.all(row.id) as MutationRow[]).map((item) => ({
      id: item.id,
      nodeId: item.node_id,
      action: item.action,
      actor: item.actor,
      source: item.source,
      requestId: item.request_id,
      reason: item.reason,
      expectedRevision: item.expected_revision,
      resultingRevision: item.resulting_revision,
      attemptId: item.attempt_id,
      childThreadId: item.child_thread_id,
      outputHash: item.output_hash,
      createdAt: item.created_at,
    }));
    return {
      ...toMeta(row, nodes),
      nodes: await enrichNodes(row.id, nodes),
      harnessSnapshot: snapshot,
      totals: planTotals(row.id),
      skillWarnings: [] as string[],
      mutations,
    };
  }

  function requirePlan(id: string): PlanRow {
    const row = selectPlan.get(id) as PlanRow | undefined;
    if (!row) throw new Error(`No plan with id ${id}`);
    return row;
  }

  async function requireParentPlan(
    planId: string,
    threadId: string | undefined,
    claimedProjectId: string | undefined,
    mode: "read" | "mutate",
  ): Promise<PlanRow> {
    if (!threadId) {
      throw new Error("Plan operations require the owning parent thread.");
    }
    const thread = await bb.sdk.threads.get({ threadId });
    if (claimedProjectId && claimedProjectId !== thread.projectId) {
      throw new Error(`projectId ${claimedProjectId} does not match thread ${threadId}.`);
    }
    const plan = requirePlan(planId);
    if (plan.thread_id === thread.id && plan.project_id === thread.projectId) {
      return plan;
    }
    if (mode === "mutate") {
      const mapped = selectNodeByChild.get(threadId) as NodeRow | undefined;
      if (mapped && mapped.plan_id === plan.id) {
        throw new Error(
          "Child threads cannot complete, skip, or rework Harness nodes. The parent operator owns those actions.",
        );
      }
    }
    throw new Error("This plan does not belong to this project or thread.");
  }

  function liveCandidatePlans(arc: ArcRow): PlanRow[] {
    return (selectPlansForThread.all(arc.project_id, arc.thread_id) as PlanRow[])
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .filter((row) =>
        nodesOf(row.id).some(
          (node) => node.status === "in_progress" || node.status === "starting",
        ),
      );
  }

  function activePlanForArc(arc: ArcRow): PlanRow | null {
    if (arc.plan_id) {
      const bound = selectPlan.get(arc.plan_id) as PlanRow | undefined;
      if (
        bound &&
        bound.thread_id === arc.thread_id &&
        bound.project_id === arc.project_id &&
        bound.lifecycle === "active"
      ) {
        return bound;
      }
      return null;
    }
    const rows = selectPlansForThread.all(arc.project_id, arc.thread_id) as PlanRow[];
    if (rows.length === 1) {
      const only = rows[0]!;
      if (only.lifecycle !== "active") {
        const expectedRevision = only.revision;
        setPlanLifecycle.run("active", Date.now(), only.id);
        only.lifecycle = "active";
        only.revision += 1;
        recordMutation({
          planId: only.id, action: "recovery.legacy_bind", actor: "system", source: "activePlanForArc",
          requestId: `legacy-bind:${arc.thread_id}:${only.id}`, reason: "Bound the only legacy plan to its owning arc.",
          expectedRevision,
        });
      }
      bindArcPlanId.run(only.id, arc.thread_id);
      arc.plan_id = only.id;
      return only;
    }
    const live = liveCandidatePlans(arc);
    if (live.length === 1) {
      const only = live[0]!;
      if (only.lifecycle !== "active") {
        const expectedRevision = only.revision;
        setPlanLifecycle.run("active", Date.now(), only.id);
        only.lifecycle = "active";
        only.revision += 1;
        recordMutation({
          planId: only.id, action: "recovery.legacy_live_select", actor: "system", source: "activePlanForArc",
          requestId: `legacy-live-select:${arc.thread_id}:${only.id}`, reason: "Selected the only live legacy candidate without resolving the ambiguous arc binding.",
          expectedRevision,
        });
      }
      return only;
    }
    return null;
  }

  async function resolveProjectId(
    threadId: string,
    claimed?: string,
  ): Promise<string> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (claimed && claimed !== thread.projectId) {
      throw new Error(
        `projectId ${claimed} does not match thread ${threadId}.`,
      );
    }
    return thread.projectId;
  }

  function readArc(threadId: string): ArcRow | null {
    return (selectArc.get(threadId) as ArcRow | undefined) ?? null;
  }

  function requireLegacyArc(threadId: string): ArcRow {
    const existing = readArc(threadId);
    if (!existing) {
      throw new Error("No active Harness run. Start one with bb harness start.");
    }
    return existing;
  }

  function historicalLiveRun(threadId: string): { id: string } | null {
    const liveStatuses = new Set([
      "configuring",
      "running",
      "awaiting_plan_approval",
      "awaiting_correction_approval",
    ]);
    const byChild = selectHistoricalRunNodeByChild.get(threadId) as { run_id: string } | undefined;
    if (byChild) {
      const row = db.prepare("SELECT * FROM harness_runs WHERE id = ?").get(byChild.run_id) as
        | { id: string; status: string }
        | undefined;
      if (row && liveStatuses.has(row.status)) return { id: row.id };
    }
    return (selectHistoricalLiveRun.get(threadId) as { id: string } | undefined) ?? null;
  }

  function writeArc(
    threadId: string,
    projectId: string,
    phase: Phase,
    note = "",
    harnessId: string | null = null,
  ): ArcRow {
    const existing = readArc(threadId);
    const row: ArcRow = {
      thread_id: threadId,
      project_id: projectId,
      phase,
      note,
      updated_at: Date.now(),
      harness_id: harnessId ?? existing?.harness_id ?? STANDARD_HARNESS_ID,
      plan_id: existing?.plan_id ?? null,
    };
    upsertArc.run(row);
    publish();
    return row;
  }

  function toArcDto(row: ArcRow) {
    return {
      threadId: row.thread_id,
      projectId: row.project_id,
      phase: (isPhase(row.phase) ? row.phase : "explore") as Phase,
      note: row.note,
      updatedAt: row.updated_at,
    };
  }

  function ownerThreadId(threadId: string): string {
    const childRow = selectNodeByChild.get(threadId) as NodeRow | undefined;
    if (!childRow) return threadId;
    const plan = selectPlan.get(childRow.plan_id) as PlanRow | undefined;
    return plan?.thread_id || threadId;
  }

  function resolvedChoice(nodes: PlanNode[], node: PlanNode): ExecutionChoice | null {
    const override = nodeChoice(node);
    if (override) return override;
    const workerIndex = workerOrdinal(nodes, node.id);
    const slot = routingSlotFor(node.phase, workerIndex >= 0 ? workerIndex : 0);
    return currentRouting[slot];
  }

  async function statusPayload(threadId: string, projectId: string) {
    const ownerId = ownerThreadId(threadId);
    const existingArc = readArc(ownerId);
    const storedPhase = existingArc && isPhase(existingArc.phase) ? existingArc.phase : "explore";
    const planRow = existingArc ? activePlanForArc(existingArc) : null;
    const projectedNodes = planRow ? nodesOf(planRow.id) : [];
    const projected = planRow ? nextWorkNode(projectedNodes) : null;
    const phase = projected?.phase ?? storedPhase;
    const arc = existingArc
      ? { ...toArcDto(existingArc), phase }
      : {
          threadId: ownerId,
          projectId,
          phase,
          note: "",
          updatedAt: 0,
        };
    const plan = planRow ? await toFull(planRow) : null;
    const snapshot = planRow ? snapshotOf(planRow) : null;
    const harnessId = existingArc?.harness_id ?? snapshot?.id ?? null;
    const harnessDef = harnessId
      ? findHarness(harnessId, snapshot) ?? snapshot ?? null
      : null;
    const harness = existingArc ? (harnessDef ? toHarnessRef(harnessDef) : null) : null;
    const nextNode = plan ? nextWorkNode(plan.nodes) : null;
    if (plan && planRow?.thread_id) {
      try {
        const parent = await bb.sdk.threads.get({ threadId: planRow.thread_id });
        const warnings: string[] = [];
        for (const n of plan.nodes) {
          if (n.execution === "parent" && (n.status === "pending" || n.status === "in_progress" || n.status === "starting")) {
            const eff = resolvedChoice(plan.nodes, n);
            if (eff && eff.providerId !== parent.providerId) {
              warnings.push(
                `${PHASE_COPY[n.phase].label} role default is ${eff.providerId}/${eff.model}, but this parent thread runs on ${parent.providerId} — the turn will inherit the parent provider. Start the Harness on a ${eff.providerId} thread or use a custom Harness with ${n.phase} as child execution for strict isolation.`,
              );
            }
          }
        }
        plan.skillWarnings = warnings;
      } catch {}
    }
    const workerIndex =
      nextNode && plan ? workerOrdinal(plan.nodes, nextNode.id) : 0;
    const tier = recommendedTier({
      phase: nextNode?.phase ?? arc.phase,
      workerIndex: workerIndex >= 0 ? workerIndex : 0,
      prewalkEnabled: currentSettings.prewalkEnabled,
    });
    return {
      arc,
      plan,
      nextNode,
      tier,
      commodityModel: currentSettings.commodityModel,
      frontierModel: currentSettings.frontierModel,
      prewalkEnabled: currentSettings.prewalkEnabled,
      routing: currentRouting,
      harness,
      customHarnesses,
    };
  }

  function nodePrompt(node: PlanNode, phase: Phase): string {
    const copy = PHASE_COPY[phase];
    return [
      `You are the ${copy.label} for one harness DAG node.`,
      copy.summary,
      "Work this node only. Do not plan, implement, and critique in the same pass.",
      "Keep auditable outputs in artifacts/.",
      phase === "critic"
        ? "When finished, stop. The parent operator records APPROVE, REWORK, or BLOCK and a short summary. Do not complete or rework this node yourself."
        : "When you finish, stop. The parent operator marks the node Done after review. Do not complete this node yourself.",
      "",
      `Node id: ${node.id}`,
      `Title: ${node.title}`,
      node.detail ? `Detail: ${node.detail}` : null,
      "Do not start the next DAG node.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  async function readChildOutputHash(threadId: string): Promise<string | null> {
    try {
      const { output } = await bb.sdk.threads.output({ threadId });
      const normalized = output?.trim();
      return normalized ? createHash("sha256").update(normalized).digest("hex") : null;
    } catch {
      return null;
    }
  }

  async function readChildTokens(threadId: string): Promise<TokenCounters | null> {
    try {
      const events = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/tokenUsage/updated"],
        order: "desc",
        limit: "20",
      });
      for (const event of events) {
        const parsed = parseTokenUsageEvent(event);
        if (parsed) return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  async function stopChildThread(
    threadId: string,
    label: string,
    outcome: AttemptRow["outcome"] = "stopped",
    outputHash: string | null = null,
  ): Promise<void> {
    try {
      await bb.sdk.threads.stop({ threadId });
      await closeAttemptForChild(threadId, outcome, outputHash);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot ${label}: failed to stop child ${threadId}. ${reason}`);
    }
  }

  async function stopLiveChildren(
    nodes: PlanNode[],
    label: string,
    predicate: (node: PlanNode) => boolean = () => true,
    outcome: AttemptRow["outcome"] = "stopped",
  ): Promise<PlanNode[]> {
    const live = nodes.filter(
      (node) =>
        (node.status === "in_progress" || node.status === "starting") &&
        node.childThreadId &&
        predicate(node),
    );
    for (const node of live) {
      await stopChildThread(node.childThreadId!, label, outcome);
    }
    return live;
  }

  async function closeAttemptForExecution(
    executionThreadId: string,
    outcome: AttemptRow["outcome"] = "idle_empty",
    outputHash: string | null = null,
  ): Promise<void> {
    let open = selectOpenAttemptByChild.get(executionThreadId) as AttemptRow | undefined;
    if (!open) open = selectOpenAttemptByExecution.get(executionThreadId) as AttemptRow | undefined;
    if (!open) {
      if (outputHash) {
        const latest = db.prepare(
          "SELECT id FROM plan_node_attempts WHERE execution_thread_id = ? OR child_thread_id = ? ORDER BY created_at DESC LIMIT 1",
        ).get(executionThreadId, executionThreadId) as { id: string } | undefined;
        if (latest) setAttemptEvidence.run(outputHash, Date.now(), Date.now(), latest.id);
      }
      return;
    }
    const endedAt = Date.now();
    const tokens = (await readChildTokens(executionThreadId)) ?? emptyTokenCounters();
    updateAttempt.run({
      id: open.id,
      ended_at: endedAt,
      duration_ms: durationMs(open.started_at, endedAt),
      tokens_input: tokens.input,
      tokens_cached: tokens.cached,
      tokens_output: tokens.output,
      tokens_reasoning: tokens.reasoning,
      tokens_total: tokens.total,
      outcome,
      output_hash: outputHash,
    });
  }

  async function closeAttemptForChild(
    childThreadId: string,
    outcome: AttemptRow["outcome"] = "idle_empty",
    outputHash: string | null = null,
  ): Promise<void> {
    return closeAttemptForExecution(childThreadId, outcome, outputHash);
  }

  async function resolveWorkspace(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) {
      throw new Error("This thread has no environment to initialize.");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (!environment.path) {
      throw new Error("Environment has no workspace path.");
    }
    return {
      hostId: environment.hostId,
      path: environment.path,
      projectId: thread.projectId,
      environmentId: thread.environmentId,
    };
  }

  async function ensureArtifactDir(threadId: string, planId: string, required: boolean): Promise<void> {
    try {
      const { hostId, path } = await resolveWorkspace(threadId);
      await bb.sdk.files.mkdir({
        hostId,
        path: `${path}/${artifactDirForPlan(planId)}`,
        rootPath: path,
        recursive: true,
      });
    } catch (error) {
      if (required) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Required artifact workspace is unavailable. ${reason}`);
      }
    }
  }

  async function writeManifest(threadId: string, planId: string): Promise<void> {
    const plan = selectPlan.get(planId) as PlanRow | undefined;
    if (!plan?.thread_id) return;
    try {
      const { hostId, path } = await resolveWorkspace(threadId);
      const full = await toFull(plan);
      const payload = {
        planId,
        harnessId: plan.harness_id,
        correctionCount: correctionCountOf(plan),
        criticBlocked: criticBlockedOf(plan),
        lifecycle: plan.lifecycle,
        revision: plan.revision,
        nodes: full.nodes.map((node) => ({
          id: node.id,
          phase: node.phase,
          status: node.status,
          result: node.result,
          artifacts: node.result?.artifactPaths ?? [],
        })),
        totals: full.totals,
        mutations: full.mutations,
        updatedAt: Date.now(),
      };
      await bb.sdk.files.write({
        hostId,
        path: `${path}/${artifactManifestPath(planId)}`,
        rootPath: path,
        content: `${JSON.stringify(payload, null, 2)}\n`,
        createParents: true,
      });
    } catch {
      // Manifest is a readable export; DB remains authoritative.
    }
  }

  function hashOutput(args: {
    verdict: CriticVerdict | null;
    summary: string | null;
    artifactPaths: string[];
  }): string {
    return createHash("sha256")
      .update(JSON.stringify({
        verdict: args.verdict,
        summary: args.summary,
        artifactPaths: [...args.artifactPaths].sort(),
      }))
      .digest("hex");
  }

  function assertExpectedRevision(plan: PlanRow, expected: number): void {
    if (plan.revision !== expected) {
      throw new Error(
        `Stale Harness state: expected plan revision ${expected}, current revision is ${plan.revision}. Refresh and review before retrying.`,
      );
    }
  }

  function recordMutation(args: {
    planId: string;
    nodeId?: string | null;
    action: string;
    actor: string;
    source: string;
    requestId: string;
    reason?: string | null;
    expectedRevision?: number | null;
    attemptId?: string | null;
    childThreadId?: string | null;
    outputHash?: string | null;
    detail?: Record<string, unknown>;
  }): void {
    const plan = requirePlan(args.planId);
    insertMutation.run({
      id: randomUUID(),
      plan_id: args.planId,
      node_id: args.nodeId ?? null,
      action: args.action,
      actor: args.actor,
      source: args.source,
      request_id: args.requestId,
      reason: args.reason ?? null,
      expected_revision: args.expectedRevision ?? null,
      resulting_revision: plan.revision,
      attempt_id: args.attemptId ?? null,
      child_thread_id: args.childThreadId ?? null,
      output_hash: args.outputHash ?? null,
      detail_json: JSON.stringify(args.detail ?? {}),
      created_at: Date.now(),
    });
    bb.log.info(
      `harness mutation ${JSON.stringify({
        planId: args.planId,
        nodeId: args.nodeId ?? null,
        action: args.action,
        requestId: args.requestId,
        revision: plan.revision,
      })}`,
    );
  }

  function recordOutcome(args: {
    planId: string;
    nodeId: string;
    verdict: CriticVerdict | null;
    summary: string | null;
    artifactPaths: string[];
    actor: string;
    source: string;
    attemptId: string | null;
    childThreadId: string | null;
    outputHash: string;
    requestId: string;
    expectedRevision: number;
  }): void {
    const now = Date.now();
    insertResult.run({
      id: randomUUID(),
      plan_id: args.planId,
      node_id: args.nodeId,
      verdict: args.verdict,
      summary: args.summary,
      artifact_paths: JSON.stringify(args.artifactPaths),
      actor: args.actor,
      source: args.source,
      attempt_id: args.attemptId,
      child_thread_id: args.childThreadId,
      output_hash: args.outputHash,
      request_id: args.requestId,
      expected_revision: args.expectedRevision,
      created_at: now,
    });
    for (const path of args.artifactPaths) {
      insertArtifact.run({
        id: randomUUID(),
        plan_id: args.planId,
        node_id: args.nodeId,
        path,
        created_at: now,
      });
    }
  }

  const threadLifecycleTails = new Map<string, Promise<unknown>>();

  async function withThreadLifecycle<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = threadLifecycleTails.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mine = previous.catch(() => undefined).then(() => held);
    threadLifecycleTails.set(threadId, mine);
    try {
      await previous.catch(() => undefined);
      return await work();
    } finally {
      release();
      if (threadLifecycleTails.get(threadId) === mine) {
        threadLifecycleTails.delete(threadId);
      }
    }
  }

  function assertActiveHarnessPlan(plan: PlanRow, threadId: string): void {
    const arc = readArc(threadId);
    if (!arc) {
      throw new Error("No active Harness run on this thread.");
    }
    const current = activePlanForArc(arc);
    if (!current || current.id !== plan.id) {
      throw new Error("This plan is not the active Harness run on this thread.");
    }
  }

  async function inheritedAttemptRouting(
    parentThreadId: string,
    parentProviderId: string,
  ): Promise<{
    providerId: string | null;
    model: string | null;
    source: string;
  }> {
    try {
      const options = await bb.sdk.threads.defaultExecutionOptions({ threadId: parentThreadId });
      if (options?.model) {
        return {
          providerId: parentProviderId,
          model: options.model,
          source: "thread/defaultExecutionOptions",
        };
      }
    } catch {
      // Missing defaults stay unknown. Do not invent a model id.
    }
    return { providerId: null, model: null, source: "inherited-unknown" };
  }

  async function startPlanNode(
    planId: string,
    nodeId: string,
    parentThreadId: string | undefined,
    expectedRevision: number,
    requestId: string,
    attribution: { actor: string; source: string },
  ) {
    const ownerId = requirePlan(planId).thread_id ?? parentThreadId;
    if (!ownerId) {
      throw new Error("Need a parent thread to execute this node.");
    }
    return withThreadLifecycle(ownerId, () =>
      startPlanNodeLocked(planId, nodeId, ownerId, expectedRevision, requestId, attribution),
    );
  }

  async function startPlanNodeLocked(
    planId: string,
    nodeId: string,
    parentThreadId: string,
    expectedRevision: number,
    requestId: string,
    attribution: { actor: string; source: string },
  ) {
    const plan = requirePlan(planId);
    assertExpectedRevision(plan, expectedRevision);
    assertActiveHarnessPlan(plan, parentThreadId);
    const node = lookupPlanNode(planId, nodeId);
    const nodes = nodesOf(planId);
    const inflight = activeNode(nodes);
    if (inflight && inflight.id !== node.id) {
      throw new Error(
        `Node ${inflight.id} is already in progress. Complete it before starting another.`,
      );
    }
    const blocked = node.deps.filter((dep) => {
      const parent = nodes.find((candidate) => candidate.id === dep);
      return parent && parent.status !== "done" && parent.status !== "skipped";
    });
    if (blocked.length > 0) {
      throw new Error(`Node ${node.id} is blocked by: ${blocked.join(", ")}`);
    }
    if (node.status === "done" || node.status === "skipped") {
      throw new Error(`Node ${node.id} is ${node.status} and cannot start.`);
    }
    if (node.phase === "promote" && criticBlockedOf(plan)) {
      throw new Error("Promote is blocked until the operator resets the Critic BLOCK.");
    }
    if (node.status === "in_progress" || node.status === "starting") {
      return { plan: await toFull(plan) };
    }

    const spawns = nodeSpawnsChild(node);
    // Claim before any await so a concurrent Start cannot spawn a second child.
    const claimed = claimNodeStatus.run(
      spawns ? "starting" : "in_progress",
      node.id,
      planId,
      "pending",
    );
    if (claimed.changes !== 1) {
      return { plan: await toFull(requirePlan(planId)) };
    }
    touchPlan.run(Date.now(), planId);
    recordMutation({
      planId, nodeId: node.id, action: "node.start", actor: attribution.actor,
      source: attribution.source, requestId, expectedRevision,
      detail: { execution: spawns ? "child" : "parent" },
    });

    const parentId = plan.thread_id ?? parentThreadId;
    if (!spawns) {
      const parentPreview = await bb.sdk.threads.get({ threadId: parentId });
      const choice = resolvedChoice(nodes, node);
      // threads.send cannot switch providers on a live thread, so a role
      // default from another provider is recorded but not applied; the turn
      // inherits the parent thread instead of failing on a foreign model id.
      const providerMatches = choice
        ? choice.providerId === parentPreview.providerId
        : false;
      const routing = choice
        ? providerMatches
          ? { providerId: choice.providerId, model: choice.model, source: "explicit-routing" }
          : { providerId: choice.providerId, model: choice.model, source: "explicit-routing-provider-mismatch" }
        : { providerId: null, model: null, source: "inherited-unknown" };
      const now = Date.now();
      const attemptId = randomUUID();
      insertAttempt.run({
        id: attemptId,
        plan_id: planId,
        node_id: node.id,
        child_thread_id: null,
        execution_thread_id: parentId,
        provider_id: routing.providerId,
        model: routing.model,
        started_at: now,
        ended_at: null,
        duration_ms: null,
        tokens_input: null,
        tokens_cached: null,
        tokens_output: null,
        tokens_reasoning: null,
        tokens_total: null,
        source: routing.source,
        outcome: "running",
        output_hash: null,
        created_at: now,
      });
      try {
        const prompt = nodePrompt(node, node.phase);
        const maybeSend = (bb.sdk.threads as unknown as { send?: (args: unknown) => Promise<unknown> }).send;
        if (typeof maybeSend === "function") {
          try {
            await maybeSend.call(bb.sdk.threads, {
              threadId: parentId,
              input: [{ type: "text", text: prompt }],
              mode: "steer-if-active",
              ...(choice && providerMatches
                ? {
                    model: choice.model,
                    reasoningLevel: choice.reasoningLevel,
                    ...(choice.serviceTier ? { serviceTier: choice.serviceTier } : {}),
                  }
                : {}),
            });
          } catch (inner) {
            const msg = inner instanceof Error ? inner.message : String(inner);
            if (msg.includes("not stubbed") || msg.includes("is not stubbed")) {
              // Test harness without a send stub — keep the attempt running for the test's idle injection.
            } else {
              throw inner;
            }
          }
        }
      } catch (sendError) {
        const nowFailed = Date.now();
        try {
          updateAttempt.run({
            id: attemptId,
            ended_at: nowFailed,
            duration_ms: durationMs(now, nowFailed),
            tokens_input: null,
            tokens_cached: null,
            tokens_output: null,
            tokens_reasoning: null,
            tokens_total: null,
            outcome: "failed",
            output_hash: null,
          });
        } catch {}
        try { resetPlanNode.run("pending", node.id, planId); } catch {}
        try { touchPlan.run(Date.now(), planId); } catch {}
        recordMutation({
          planId, nodeId: node.id, action: "node.start_failed", actor: attribution.actor,
          source: attribution.source, requestId: `${requestId}:send_failed`, expectedRevision,
          attemptId, childThreadId: null, outputHash: null,
          reason: sendError instanceof Error ? sendError.message : String(sendError),
        });
        throw new Error(`Failed to start ${PHASE_COPY[node.phase].label} in this thread: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
      }
      publish();
      return { plan: await toFull(requirePlan(planId)) };
    }

    const recoverClaim = () => {
      recoverStartingNode.run(node.id, planId);
    };


    let spawnedId: string | null = null;
    try {
      const parent = await bb.sdk.threads.get({ threadId: parentId });
      if (!parent.environmentId) {
        recoverClaim();
        throw new Error("Parent thread has no environment; cannot spawn a child.");
      }
      const choice = resolvedChoice(nodes, node);
      // Routing must be resolved before spawn so attach can run with no await
      // between the spawn result and the child row.
      const routing = choice
        ? {
            providerId: choice.providerId,
            model: choice.model,
            source: "explicit-routing",
          }
        : await inheritedAttemptRouting(parent.id, parent.providerId);
      const title = `${PHASE_COPY[node.phase].label}: ${node.title}`.slice(0, 80);
      const child = await bb.sdk.threads.spawn({
        prompt: nodePrompt(node, node.phase),
        parentThreadId: parent.id,
        projectId: parent.projectId,
        title,
        visibility: "visible",
        origin: "plugin",
        ...(node.phase === "critic" || node.phase === "promote"
          ? { permissionMode: "accept-edits" as const }
          : {}),
        environment: { type: "reuse", environmentId: parent.environmentId },
        ...(choice
          ? {
              providerId: choice.providerId,
              model: choice.model,
              reasoningLevel: choice.reasoningLevel,
              ...(choice.serviceTier
                ? { serviceTier: choice.serviceTier }
                : {}),
              executionInputSources: {
                providerId: "explicit" as const,
                model: "explicit" as const,
                reasoningLevel: "explicit" as const,
                ...(choice.serviceTier
                  ? { serviceTier: "explicit" as const }
                  : {}),
              },
            }
          : {}),
      });
      spawnedId = child.id;
      const attached = db.transaction(() => {
        const result = attachStartingChild.run(child.id, node.id, planId);
        if (result.changes !== 1) return false;
        const now = Date.now();
        insertAttempt.run({
          id: randomUUID(),
          plan_id: planId,
          node_id: node.id,
          child_thread_id: child.id,
          execution_thread_id: child.id,
          provider_id: routing.providerId,
          model: routing.model,
          started_at: now,
          ended_at: null,
          duration_ms: null,
          tokens_input: null,
          tokens_cached: null,
          tokens_output: null,
          tokens_reasoning: null,
          tokens_total: null,
          source: routing.source,
          outcome: "running",
          output_hash: null,
          created_at: now,
        });
        return true;
      })();
      if (!attached) {
        throw new Error("Node start claim was lost before the child could be attached.");
      }
      const attempt = selectLatestAttemptForNode.get(planId, node.id) as AttemptRow;
      recordMutation({
        planId, nodeId: node.id, action: "child.attach", actor: attribution.actor,
        source: attribution.source, requestId: `${requestId}:attach`, expectedRevision,
        attemptId: attempt.id, childThreadId: child.id,
      });
    } catch (error) {
      recoverClaim();
      recordMutation({
        planId, nodeId: node.id, action: "node.start_failed", actor: attribution.actor,
        source: attribution.source, requestId: `${requestId}:failed`, expectedRevision,
        childThreadId: spawnedId,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (spawnedId) {
        try {
          await bb.sdk.threads.stop({ threadId: spawnedId });
        } catch (stopError) {
          const reason = stopError instanceof Error ? stopError.message : String(stopError);
          throw new Error(
            `Child ${spawnedId} was spawned but not attached and could not be stopped. ${reason}`,
          );
        }
      }
      throw error;
    }
    publish();
    return { plan: await toFull(requirePlan(planId)) };
  }

  async function firstAvailableChoice(): Promise<ExecutionChoice> {
    const catalog = await bb.sdk.providers.models();
    const provider =
      catalog.providers.find((item) => item.available) ?? catalog.providers[0];
    if (!provider) {
      throw new Error("No providers available. Sign in to a provider first.");
    }
    const scoped = catalog.models.filter(
      (item) => !item.routeProviderId || item.routeProviderId === provider.id,
    );
    const model =
      scoped.find((item) => item.isDefault) ??
      scoped[0] ??
      catalog.models.find((item) => item.isDefault) ??
      catalog.models[0];
    if (!model) {
      throw new Error(`Provider ${provider.id} has no models.`);
    }
    return {
      providerId: provider.id,
      model: model.model,
      reasoningLevel: model.defaultReasoningEffort,
    };
  }

  function insertSeedNodes(planId: string, definition?: HarnessDefinition): void {
    const source = definition ?? standardHarnessDefinition();
    for (const [index, node] of seedNodesFromDefinition(planId, source).entries()) {
      insertNode.run({
        id: node.id,
        plan_id: planId,
        title: node.title,
        detail: node.detail,
        phase: node.phase,
        status: node.status ?? "pending",
        deps: JSON.stringify(node.deps),
        sort_order: index,
        execution: node.execution,
        skills: JSON.stringify([]),
      });
    }
  }

  function persistPlanSnapshot(planId: string, definition: HarnessDefinition): void {
    updatePlanSnapshot.run(
      definition.id,
      JSON.stringify(snapshotHarness(definition)),
      Date.now(),
      planId,
    );
  }

  function uniqueNodeId(planId: string, title: string): string {
    const taken = new Set(
      (selectAllNodeIds.all() as Array<{ id: string }>).map((row) => row.id),
    );
    return namespacedNodeId(planId, title, taken, shortId);
  }

  function lookupPlanNode(planId: string, nodeId: string): PlanNode {
    const nodes = nodesOf(planId);
    const resolved = resolveNodeRef(nodes, nodeId, planId);
    const node = nodes.find((candidate) => candidate.id === resolved);
    if (!node) throw new Error(`No node ${nodeId} on plan ${planId}`);
    return node;
  }

  function addPlanNode(args: {
    planId: string;
    title: string;
    detail?: string;
    phase?: Phase;
    deps?: string[];
    expectedRevision?: number;
    requestId?: string;
    attribution?: { actor: string; source: string };
  }): void {
    const planId = args.planId;
    const plan = requirePlan(planId);
    if (args.expectedRevision != null) assertExpectedRevision(plan, args.expectedRevision);
    const snapshot = snapshotOf(plan);
    const nodes = nodesOf(planId);
    const id = uniqueNodeId(planId, args.title);
    const resolvedDeps = resolveDependencyIds(nodes, args.deps ?? [], planId);
    const phase = args.phase ?? "worker";
    const spec = snapshot?.phases[phase];
    const detail = args.detail ?? spec?.detail ?? "";
    const execution = spec?.execution;
    const skills: string[] = [];
    assertNewNodeDeps(nodes, {
      id,
      title: args.title,
      detail,
      phase,
      status: "pending",
      deps: resolvedDeps,
      sortOrder: nodes.length,
    });
    insertNode.run({
      id,
      plan_id: planId,
      title: args.title,
      detail,
      phase,
      status: "pending",
      deps: JSON.stringify(resolvedDeps),
      sort_order: nodes.length,
      execution: execution ?? (nodeSpawnsChild({ phase }) ? "child" : "parent"),
      skills: JSON.stringify(skills),
    });
    touchPlan.run(Date.now(), planId);
    if (args.requestId && args.attribution) {
      recordMutation({
        planId, nodeId: id, action: "node.add", actor: args.attribution.actor,
        source: args.attribution.source, requestId: args.requestId,
        expectedRevision: args.expectedRevision, detail: { phase, deps: resolvedDeps, title: args.title },
      });
    }
  }

  async function stopInProgressCriticChildren(planId: string): Promise<PlanNode[]> {
    return stopLiveChildren(nodesOf(planId), "reopen Worker", (node) => node.phase === "critic");
  }

  async function reopenPlanNode(
    planId: string,
    nodeId: string,
    attribution: { actor: string; source: string; requestId: string; reason: string; expectedRevision: number },
  ): Promise<PlanNode> {
    const plan = requirePlan(planId);
    assertExpectedRevision(plan, attribution.expectedRevision);
    const node = lookupPlanNode(planId, nodeId);
    if (node.phase !== "worker") {
      throw new Error("Only Worker nodes can be reopened after Critic.");
    }
    if (node.status !== "done") {
      throw new Error(`Node ${node.id} must be done before it can be reopened.`);
    }
    const critics = await stopInProgressCriticChildren(planId);
    persistWorkerReopen(planId, node.id, critics);
    recordMutation({
      planId, nodeId: node.id, action: "recovery.worker_reopen",
      actor: attribution.actor, source: attribution.source, requestId: attribution.requestId,
      reason: attribution.reason, expectedRevision: attribution.expectedRevision,
    });
    return lookupPlanNode(planId, node.id);
  }

  function persistWorkerReopen(planId: string, workerId: string, critics: PlanNode[]): void {
    const mutate = db.transaction(() => {
      resetPlanNode.run("pending", workerId, planId);
      for (const critic of critics) {
        updateNodeStatus.run("pending", critic.id, planId);
      }
      touchPlan.run(Date.now(), planId);
    });
    mutate();
    publish();
  }

  function requireArtifactPaths(raw: string[] | undefined): string[] {
    const parsed = parseArtifactPaths(raw);
    if (!parsed) {
      throw new Error(
        "Artifact refs must be relative paths under artifacts/ with no absolute or parent-directory segments.",
      );
    }
    return parsed;
  }

  async function completePlanNode(
    input: z.infer<typeof completeNodeInputSchema>,
    attribution: { actor: string; source: string },
  ): Promise<PlanNode> {
    const plan = requirePlan(input.planId);
    assertExpectedRevision(plan, input.expectedRevision);
    const node = lookupPlanNode(input.planId, input.nodeId);
    if (node.status !== "in_progress") {
      throw new Error(`Node ${node.id} must be in progress to mark done.`);
    }
    if (node.phase === "promote" && criticBlockedOf(plan)) {
      throw new Error("Promote is blocked until the operator resets the Critic BLOCK.");
    }
    const artifactPaths = requireArtifactPaths(input.artifactPaths);
    const summary = input.summary?.trim() || null;
    const verdict = node.phase === "critic" ? input.verdict ?? null : null;
    if (node.phase === "critic" && !verdict) {
      throw new Error("Critic completion requires verdict APPROVE, REWORK, or BLOCK.");
    }
    if (node.phase === "critic" && !summary) {
      throw new Error("Critic completion requires a short summary.");
    }
    if (nodeSpawnsChild(node) && !summary && artifactPaths.length === 0) {
      throw new Error(
        `${PHASE_COPY[node.phase].label} completion requires a summary or artifact reference.`,
      );
    }
    const attempt = selectLatestAttemptForNode.get(input.planId, node.id) as AttemptRow | undefined;
    if (!attempt) {
      throw new Error("No active attempt for this node. Start the node and wait for output before completing it.");
    }
    if (input.expectedAttemptId !== attempt.id) {
      throw new Error("Stale attempt: refresh and review the current attempt before completing this node.");
    }
    const isParentExecution = !nodeSpawnsChild(node);
    if (isParentExecution) {
      if (attempt.execution_thread_id !== plan.thread_id) {
        throw new Error("Parent attempt does not match the owning thread.");
      }
      if (attempt.outcome !== "idle_with_output" || !attempt.output_hash) {
        throw new Error(`${PHASE_COPY[node.phase].label} has not produced output in this thread yet. Wait for the agent response, review it, then complete.`);
      }
    } else {
      if (attempt.child_thread_id !== node.childThreadId) {
        throw new Error("The active child has no matching attempt record. Use audited recovery instead of completing it.");
      }
    }
    let outputHash: string;
    if (isParentExecution) {
      outputHash = attempt.output_hash!;
    } else {
      const childOutputHash = node.childThreadId ? await readChildOutputHash(node.childThreadId) : null;
      if (!childOutputHash) {
        throw new Error(`${PHASE_COPY[node.phase].label} child output is empty or unavailable; do not mark this attempt complete.`);
      }
      outputHash = childOutputHash;
    }
    let reworkWorker: PlanNode | undefined;
    if (verdict === "REWORK") {
      const maxCorrections = snapshotOf(plan)?.maxCorrections ?? null;
      if (!canRework(correctionCountOf(plan), maxCorrections)) {
        throw new Error(`Correction limit reached (${correctionCountOf(plan)}/${maxCorrections}).`);
      }
      reworkWorker = nodesOf(input.planId)
        .filter((item) => item.phase === "worker" && item.status === "done")
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .at(-1);
      if (!reworkWorker) throw new Error("REWORK requires a completed Worker node.");
    }
    if (node.childThreadId) {
      await stopChildThread(node.childThreadId, `complete ${PHASE_COPY[node.phase].label}`, "idle_with_output", outputHash);
    }

    if (verdict === "REWORK") {
      const lastWorker = reworkWorker!;
      db.transaction(() => {
        recordOutcome({
          planId: input.planId, nodeId: node.id, verdict, summary, artifactPaths,
          actor: attribution.actor, source: attribution.source,
          attemptId: attempt?.id ?? null, childThreadId: node.childThreadId ?? null,
          outputHash, requestId: input.requestId, expectedRevision: input.expectedRevision,
        });
        resetPlanNode.run("pending", lastWorker.id, input.planId);
        resetPlanNode.run("pending", node.id, input.planId);
        updatePlanFlags.run(correctionCountOf(plan) + 1, plan.critic_blocked, Date.now(), input.planId);
        recordMutation({
          planId: input.planId, nodeId: node.id, action: "critic.rework",
          actor: attribution.actor, source: attribution.source, requestId: input.requestId,
          reason: summary, expectedRevision: input.expectedRevision, attemptId: attempt?.id,
          childThreadId: node.childThreadId, outputHash,
          detail: { reopenedWorkerId: lastWorker.id },
        });
      })();
    } else {
      db.transaction(() => {
        recordOutcome({
          planId: input.planId, nodeId: node.id, verdict, summary, artifactPaths,
          actor: attribution.actor, source: attribution.source,
          attemptId: attempt?.id ?? null, childThreadId: node.childThreadId ?? null,
          outputHash, requestId: input.requestId, expectedRevision: input.expectedRevision,
        });
        updateNodeStatus.run("done", node.id, input.planId);
        if (node.phase === "critic") {
          updatePlanFlags.run(correctionCountOf(plan), verdict === "BLOCK" ? 1 : 0, Date.now(), input.planId);
        } else {
          touchPlan.run(Date.now(), input.planId);
        }
        const allTerminal = nodesOf(input.planId).every(
          (item) => item.status === "done" || item.status === "skipped",
        );
        if (allTerminal) {
          setPlanLifecycle.run("completed", Date.now(), input.planId);
          if (plan.thread_id) deleteArc.run(plan.thread_id);
        }
        recordMutation({
          planId: input.planId, nodeId: node.id, action: "node.complete",
          actor: attribution.actor, source: attribution.source, requestId: input.requestId,
          reason: summary, expectedRevision: input.expectedRevision, attemptId: attempt?.id,
          childThreadId: node.childThreadId, outputHash, detail: { verdict },
        });
      })();
    }
    if (plan.thread_id) await writeManifest(plan.thread_id, input.planId);
    publish();
    return lookupPlanNode(input.planId, node.id);
  }

  async function skipPlanNode(
    planId: string,
    nodeId: string,
    attribution: { actor: string; source: string; requestId: string; reason: string; expectedRevision: number },
  ): Promise<PlanNode> {
    const ownerId = requirePlan(planId).thread_id;
    const skip = async () => {
      const plan = requirePlan(planId);
      assertExpectedRevision(plan, attribution.expectedRevision);
      const node = lookupPlanNode(planId, nodeId);
      if (
        (node.status === "starting" || node.status === "in_progress") &&
        plan.thread_id
      ) {
        assertActiveHarnessPlan(plan, plan.thread_id);
      }
      if (node.status === "starting") {
        throw new Error(
          `Cannot skip ${node.id} while it is starting. Retry after the child is attached.`,
        );
      }
      if (node.status === "in_progress" && node.childThreadId) {
        await stopChildThread(node.childThreadId, "skip this node");
      }
      updateNodeStatus.run("skipped", node.id, planId);
      touchPlan.run(Date.now(), planId);
      recordMutation({
        planId, nodeId: node.id, action: "node.skip", actor: attribution.actor,
        source: attribution.source, requestId: attribution.requestId,
        reason: attribution.reason, expectedRevision: attribution.expectedRevision,
      });
      publish();
      return lookupPlanNode(planId, node.id);
    };
    if (!ownerId) return skip();
    return withThreadLifecycle(ownerId, skip);
  }

  function resetCriticBlock(
    planId: string,
    attribution: { actor: string; source: string; requestId: string; reason: string; expectedRevision: number },
  ): void {
    const plan = requirePlan(planId);
    assertExpectedRevision(plan, attribution.expectedRevision);
    db.transaction(() => {
      updatePlanFlags.run(correctionCountOf(plan), 0, Date.now(), planId);
      recordMutation({
        planId, action: "critic.block_reset", actor: attribution.actor,
        source: attribution.source, requestId: attribution.requestId,
        reason: attribution.reason, expectedRevision: attribution.expectedRevision,
      });
    })();
    publish();
  }

  function formatStatus(status: Awaited<ReturnType<typeof statusPayload>>): string {
    const { arc, nextNode, tier, plan, harness } = status;
    if (!harness) {
      return `Harness: inactive (${arc.threadId})`;
    }
    const copy = PHASE_COPY[arc.phase];
    const choice = nextNode
      ? resolvedChoice(plan?.nodes ?? [], nextNode)
      : currentRouting[routingSlotFor(arc.phase, 0)];
    const lines = [
      `Harness: ${harness.name} (${arc.threadId})`,
      `Phase: ${copy.label}`,
      copy.summary,
      `Model: ${formatChoice(choice)}  (prewalk ${tier})`,
    ];
    if (plan) {
      lines.push(
        `Plan: ${plan.name} (${plan.id})  ${plan.doneCount}/${plan.nodeCount} done  corrections ${plan.correctionCount}${plan.criticBlocked ? "  BLOCKED" : ""}`,
      );
      if (plan.totals.durationMs != null || plan.totals.tokens.total != null) {
        lines.push(
          `Child telemetry: ${plan.totals.durationMs ?? "—"}ms  tokens ${plan.totals.tokens.total ?? "—"}`,
        );
      }
      for (const warning of plan.skillWarnings) lines.push(warning);
    }
    if (nextNode) {
      lines.push(
        `Next node: [${nextNode.status}] ${nextNode.id}  ${nextNode.title}`,
      );
    }
    return lines.join("\n");
  }

  function formatPlan(plan: Awaited<ReturnType<typeof toFull>>): string {
    const lines = [
      `${plan.name} (${plan.id})  ${plan.doneCount}/${plan.nodeCount} done  corrections ${plan.correctionCount}${plan.criticBlocked ? "  BLOCKED" : ""}`,
    ];
    for (const node of plan.nodes) {
      const mark =
        node.status === "done"
          ? "x"
          : node.status === "in_progress" || node.status === "starting"
            ? ">"
            : node.status === "skipped"
              ? "-"
              : " ";
      const deps = node.deps.length > 0 ? `  deps:${node.deps.join(",")}` : "";
      const child = node.childThreadId ? `  child:${node.childThreadId}` : "";
      const model = node.model ? `  ${node.providerId}/${node.model}` : "";
      const verdict = node.result?.verdict ? `  ${node.result.verdict}` : "";
      const tokens = node.attempt?.tokens.total != null ? `  tok:${node.attempt.tokens.total}` : "";
      lines.push(
        `[${mark}] ${node.id.padEnd(16)} ${node.phase.padEnd(8)} ${node.title}${deps}${child}${model}${verdict}${tokens}`,
      );
    }
    const next = nextWorkNode(plan.nodes);
    if (next) lines.push(`Next: ${next.id} — ${next.title}`);
    return lines.join("\n");
  }

  async function initWorkspace(threadId: string, claimedProjectId?: string) {
    await resolveProjectId(threadId, claimedProjectId);
    const { hostId, path } = await resolveWorkspace(threadId);
    const written: string[] = [];
    const skipped: string[] = [];
    const files: Array<{ relative: string; content: string }> = [
      {
        relative: "HARNESS.md",
        content: [
          "# Harness",
          "",
          "Explore → Plan → Worker → Critic → Promote.",
          "",
          "- Isolate roles. A prompt that plans, implements, and critiques itself confuses its own objectives.",
          "- Explore and Plan stay on the parent thread. Worker, Critic, and Promote spawn visible children.",
          "- Standard Harness is the default. Custom Harnesses clone it with bounded policies.",
          "- DAG state projects the phase; generic advance/rewind is disabled.",
          "- Critic completes with APPROVE, structured REWORK, or BLOCK plus a summary.",
          "- Child completion needs a summary or artifact reference bound to the current attempt.",
          "- Keep auditable outputs in `artifacts/`.",
          "- Recovery actions require an explicit reason.",
          "",
          "Commands: `bb harness status|start|stop|plan …`",
          "",
        ].join("\n"),
      },
      {
        relative: "artifacts/.gitkeep",
        content: "",
      },
      {
        relative: "plans/README.md",
        content: [
          "# plans/",
          "",
          "DAG task lists live here when you export them. The Harness plugin",
          "also stores plans in its own database so the sidebar stays live.",
          "",
          "Create one with `bb harness plan create \"Name\" --seed`.",
          "",
        ].join("\n"),
      },
    ];
    for (const relative of ["artifacts", "plans"]) {
      try {
        await bb.sdk.files.mkdir({
          hostId,
          path: `${path}/${relative}`,
          rootPath: path,
          recursive: true,
        });
      } catch {
        // Directory already exists.
      }
    }
    for (const file of files) {
      const result = await bb.sdk.files.write({
        hostId,
        path: `${path}/${file.relative}`,
        rootPath: path,
        content: file.content,
        createParents: true,
        expectedSha256: null,
      });
      if (result.outcome === "written") written.push(file.relative);
      else skipped.push(file.relative);
    }
    return { path, written, skipped };
  }

  function assertCanStart(threadId: string): void {
    if (readArc(threadId)) {
      throw new Error("A Harness run is already active on this thread.");
    }
  }

  async function startManualHarness(
    input: z.infer<typeof startRunInputSchema>,
    definition: HarnessDefinition,
    attribution: { actor: string; source: string; requestId: string },
  ): Promise<void> {
    const projectId = await resolveProjectId(input.threadId, input.projectId);
    await stopHistoricalRun(input.threadId);
    assertCanStart(input.threadId);
    const orphaned = selectActivePlansForThread.all(projectId, input.threadId) as PlanRow[];
    for (const orphan of orphaned) {
      setPlanLifecycle.run("superseded", Date.now(), orphan.id);
      recordMutation({
        planId: orphan.id, action: "run.superseded", actor: "system", source: "startRun",
        requestId: `${attribution.requestId}:supersede:${orphan.id}`,
        reason: "An orphaned active plan had no owning arc when a new run started.",
        expectedRevision: orphan.revision,
      });
    }
    const now = Date.now();
    const frozen = snapshotHarness(definition);
    const planId = shortId();
    if (frozen.artifactPolicy === "required") {
      await ensureArtifactDir(input.threadId, planId, true);
    } else if (frozen.artifactPolicy === "advisory") {
      await ensureArtifactDir(input.threadId, planId, false);
    }
    const row: PlanRow = {
      id: planId,
      project_id: projectId,
      thread_id: input.threadId,
      name: input.objective.trim().slice(0, 200),
      created_at: now,
      updated_at: now,
      harness_id: frozen.id,
      harness_snapshot: JSON.stringify(frozen),
      correction_count: 0,
      critic_blocked: 0,
      lifecycle: "active",
      revision: 0,
    };
    const insertAll = db.transaction(() => {
      insertArc.run({
        thread_id: input.threadId,
        project_id: projectId,
        phase: "explore",
        note: input.objective.trim(),
        updated_at: now,
        harness_id: frozen.id,
        plan_id: planId,
      });
      insertPlan.run(row);
      insertSeedNodes(row.id, frozen);
    });
    try {
      insertAll();
      recordMutation({
        planId, action: "run.start", actor: attribution.actor, source: attribution.source,
        requestId: attribution.requestId, reason: input.objective.trim(), expectedRevision: 0,
        detail: { harnessId: frozen.id },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE")) {
        throw new Error("A Harness run is already active on this thread.");
      }
      throw error;
    }
    if (frozen.artifactPolicy !== "off") {
      await writeManifest(input.threadId, planId);
    }
    publish();
  }


  async function startRun(
    input: z.infer<typeof startRunInputSchema>,
    attribution: { actor: string; source: string; requestId: string },
  ): Promise<void> {
    const harnessId = resolveHarnessId(input);
    const definition = requireHarness(harnessId);
    await startManualHarness(input, definition, attribution);
  }

  async function stopHistoricalRun(threadId: string): Promise<boolean> {
    const live = historicalLiveRun(threadId);
    if (!live) return false;
    const now = Date.now();
    cancelHistoricalRun.run(now, now, live.id);
    failHistoricalRunNode.run(now, live.id);
    const children = selectHistoricalRunNodes.all(live.id) as Array<{ child_thread_id: string | null }>;
    for (const child of children) {
      if (!child.child_thread_id) continue;
      try {
        await bb.sdk.threads.stop({ threadId: child.child_thread_id });
      } catch {
        // Best-effort cleanup of leftover Milestone children.
      }
    }
    return true;
  }

  async function stopRun(
    threadId: string,
    claimedProjectId: string | undefined,
    expectedRevision: number,
    requestId: string,
    reason: string,
    attribution: { actor: string; source: string },
  ): Promise<void> {
    const projectId = await resolveProjectId(threadId, claimedProjectId);
    return withThreadLifecycle(threadId, async () => {
    const stoppedHistorical = await stopHistoricalRun(threadId);
    const arc = readArc(threadId);
    if (arc) {
      if (arc.project_id !== projectId) {
        throw new Error(`projectId ${arc.project_id} does not match thread ${threadId}.`);
      }
      const plan = activePlanForArc(arc);
      if (plan) {
        assertExpectedRevision(plan, expectedRevision);
        const live = nodesOf(plan.id);
        await stopLiveChildren(live, "stop Harness", () => true, "interrupted");
        for (const node of live) {
          if ((node.status === "in_progress" || node.status === "starting") && !nodeSpawnsChild(node)) {
            const open = selectOpenAttemptForNode.get(plan.id, node.id) as AttemptRow | undefined;
            if (open) await closeAttemptForExecution(plan.thread_id!, "interrupted", null);
          }
        }
        const settle = db.transaction(() => {
          for (const node of nodesOf(plan.id)) {
            if (node.status === "in_progress") {
              updateNodeStatus.run("skipped", node.id, plan.id);
            }
          }
          setPlanLifecycle.run("cancelled", Date.now(), plan.id);
          recordMutation({
            planId: plan.id, action: "run.stop", actor: attribution.actor, source: attribution.source,
            requestId, reason, expectedRevision,
          });
          deleteArc.run(threadId);
        });
        settle();
      } else {
        const candidates = liveCandidatePlans(arc);
        if (candidates.length > 1) {
          const live = candidates.flatMap((candidate) => nodesOf(candidate.id));
          const childIds = live
            .filter(
              (node) =>
                (node.status === "in_progress" || node.status === "starting") &&
                node.childThreadId,
            )
            .map((node) => node.childThreadId!);
          for (const childId of childIds) {
            try {
              await bb.sdk.threads.stop({ threadId: childId });
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              throw new Error(
                `Cannot stop Harness: failed to stop child ${childId}. ${reason}`,
              );
            }
          }
          const settle = db.transaction(() => {
            for (const candidate of candidates) {
              const candidateRevision = candidate.revision;
              for (const node of nodesOf(candidate.id)) {
                if (node.status === "in_progress" || node.status === "starting") {
                  updateNodeStatus.run("skipped", node.id, candidate.id);
                }
              }
              setPlanLifecycle.run("cancelled", Date.now(), candidate.id);
              recordMutation({
                planId: candidate.id, action: "recovery.ambiguous_stop",
                actor: attribution.actor, source: attribution.source,
                requestId: `${requestId}:${candidate.id}`, reason,
                expectedRevision: candidateRevision,
              });
            }
            deleteArc.run(threadId);
          });
          settle();
          for (const childId of childIds) {
            await closeAttemptForChild(childId, "interrupted");
          }
        } else {
          deleteArc.run(threadId);
        }
      }
      publish();
      return;
    }
    if (stoppedHistorical) {
      publish();
      return;
    }
    throw new Error("No Harness run on this thread.");
    });
  }

  async function reconcileFailedChild(threadId: string): Promise<void> {
    const initial = selectNodeByChild.get(threadId) as NodeRow | undefined;
    if (!initial) return;
    const plan = selectPlan.get(initial.plan_id) as PlanRow | undefined;
    const reconcile = async () => {
      await closeAttemptForChild(threadId, "failed");
      // Re-read under the parent lifecycle lock, then CAS. A completed, skipped,
      // stopped, or newer attempt cannot be overwritten by a late failure event.
      const row = selectNodeByChild.get(threadId) as NodeRow | undefined;
      if (!row) return;
      const changed = casFailedChild.run(row.id, row.plan_id, threadId);
      if (changed.changes !== 1) return;
      const before = requirePlan(row.plan_id);
      touchPlan.run(Date.now(), row.plan_id);
      const attempt = selectLatestAttemptForNode.get(row.plan_id, row.id) as AttemptRow | undefined;
      recordMutation({
        planId: row.plan_id, nodeId: row.id, action: "child.failed_reconcile",
        actor: "system", source: "thread.failed", requestId: `failed:${threadId}:${Date.now()}`,
        reason: "Child thread failed; node returned to pending.", expectedRevision: before.revision,
        attemptId: attempt?.id, childThreadId: threadId,
      });
      publish();
    };
    if (plan?.thread_id) {
      await withThreadLifecycle(plan.thread_id, reconcile);
    } else {
      await reconcile();
    }
  }

  bb.rpc.register(rpcContract, {
    getStatus: async ({ threadId, projectId }) =>
      statusPayload(threadId, await resolveProjectId(threadId, projectId)),
    setPhase: async ({ threadId, projectId, phase, note, reason, expectedRevision, requestId }) => {
      const resolved = await resolveProjectId(threadId, projectId);
      const arc = requireLegacyArc(threadId);
      const plan = activePlanForArc(arc);
      if (!plan) throw new Error("No active plan is available for phase recovery.");
      assertExpectedRevision(plan, expectedRevision);
      writeArc(threadId, resolved, phase, note ?? "");
      touchPlan.run(Date.now(), plan.id);
      recordMutation({
        planId: plan.id, action: "recovery.phase_set", actor: "operator", source: "rpc",
        requestId, reason, expectedRevision, detail: { phase },
      });
      return statusPayload(threadId, resolved);
    },
    advance: async () => {
      throw new Error("Phase is derived from DAG state. Start or complete the current node instead.");
    },
    rewind: async () => {
      throw new Error("Normal rewind is disabled. Record Critic REWORK, or use an explicit recovery action.");
    },
    listPlans: async ({ projectId, threadId }) => {
      if (threadId) await resolveProjectId(threadId, projectId);
      const rows = (
        threadId
          ? (selectPlansForThread.all(projectId, threadId) as PlanRow[])
          : (selectPlans.all(projectId) as PlanRow[])
      );
      return { plans: rows.map((row) => toMeta(row)) };
    },
    getPlan: async ({ id, projectId, threadId }) => {
      const row = selectPlan.get(id) as PlanRow | undefined;
      if (!row) return { plan: null };
      await requireParentPlan(id, threadId, projectId, "read");
      return { plan: await toFull(row) };
    },
    createPlan: async ({ projectId, threadId, name, seedArc }) => {
      const resolvedProject = await resolveProjectId(threadId, projectId);
      const now = Date.now();
      const row: PlanRow = {
        id: shortId(),
        project_id: resolvedProject,
        thread_id: threadId,
        name,
        created_at: now,
        updated_at: now,
        harness_id: STANDARD_HARNESS_ID,
        harness_snapshot: null,
        correction_count: 0,
        critic_blocked: 0,
        lifecycle: "archived",
        revision: 0,
      };
      insertPlan.run(row);
      if (seedArc !== false) {
        const frozen = snapshotHarness(standardHarnessDefinition(now));
        insertSeedNodes(row.id, frozen);
        persistPlanSnapshot(row.id, frozen);
      }
      publish();
      return { plan: await toFull(requirePlan(row.id)) };
    },
    addNode: async ({ planId, title, detail, phase, deps, projectId, threadId, expectedRevision, requestId }) => {
      const plan = await requireParentPlan(planId, threadId, projectId, "mutate");
      addPlanNode({
        planId, title, detail, phase, deps, expectedRevision, requestId,
        attribution: { actor: "operator", source: "rpc" },
      });
      publish();
      return { plan: await toFull(plan) };
    },
    startNode: async ({ planId, nodeId, threadId, projectId, expectedRevision, requestId }) => {
      await requireParentPlan(planId, threadId, projectId, "mutate");
      return startPlanNode(planId, nodeId, threadId, expectedRevision, requestId, {
        actor: "operator", source: "rpc",
      });
    },
    getRouting: () => ({ routing: currentRouting }),
    setRouting: async ({ slot, choice }) => {
      if (!isRoutingSlot(slot)) throw new Error(`Unknown routing slot ${slot}`);
      const next = { ...currentRouting, [slot]: choice };
      return { routing: await saveRouting(next) };
    },
    setNodeRouting: async ({ planId, nodeId, choice, projectId, threadId, expectedRevision, requestId }) => {
      const plan = await requireParentPlan(planId, threadId, projectId, "mutate");
      assertExpectedRevision(plan, expectedRevision);
      const node = lookupPlanNode(planId, nodeId);
      updateNodeChoice.run(
        choice?.providerId ?? null,
        choice?.model ?? null,
        choice?.reasoningLevel ?? null,
        choice?.serviceTier ?? null,
        node.id,
        planId,
      );
      touchPlan.run(Date.now(), planId);
      recordMutation({
        planId, nodeId: node.id, action: "node.routing_set", actor: "operator", source: "rpc",
        requestId, expectedRevision, detail: { choice },
      });
      publish();
      return { plan: await toFull(plan) };
    },
    suggestChoice: async () => ({ choice: await firstAvailableChoice() }),
    completeNode: async (input) => {
      const plan = await requireParentPlan(input.planId, input.threadId, input.projectId, "mutate");
      await withThreadLifecycle(input.threadId, () =>
        completePlanNode(input, { actor: "operator", source: "rpc" }),
      );
      return { plan: await toFull(requirePlan(plan.id)) };
    },
    skipNode: async ({ planId, nodeId, projectId, threadId, ...attribution }) => {
      const plan = await requireParentPlan(planId, threadId, projectId, "mutate");
      await skipPlanNode(planId, nodeId, { actor: "operator", source: "rpc", ...attribution });
      return { plan: await toFull(plan) };
    },
    reopenNode: async ({ planId, nodeId, projectId, threadId, recovery: _recovery, ...attribution }) => {
      await requireParentPlan(planId, threadId, projectId, "mutate");
      await withThreadLifecycle(threadId, () =>
        reopenPlanNode(planId, nodeId, { actor: "operator", source: "rpc", ...attribution }),
      );
      return { plan: await toFull(requirePlan(planId)) };
    },
    resetCriticBlock: async ({ planId, projectId, threadId, ...attribution }) => {
      await requireParentPlan(planId, threadId, projectId, "mutate");
      resetCriticBlock(planId, { actor: "operator", source: "rpc", ...attribution });
      return { plan: await toFull(requirePlan(planId)) };
    },
    initWorkspace: ({ threadId, projectId }) => initWorkspace(threadId, projectId),
    startRun: async (input) => {
      await startRun(input, {
        actor: "operator", source: "rpc", requestId: `rpc-start:${randomUUID()}`,
      });
      return statusPayload(
        input.threadId,
        await resolveProjectId(input.threadId, input.projectId),
      );
    },
    stopRun: async ({ threadId, projectId, expectedRevision, requestId, reason }) => {
      await stopRun(
        threadId, projectId, expectedRevision, requestId, reason,
        { actor: "operator", source: "rpc" },
      );
      return statusPayload(threadId, await resolveProjectId(threadId, projectId));
    },
    listHarnesses: () => ({ harnesses: catalogHarnesses() }),
    createHarness: async (draft) => {
      const created = cloneStandardHarness(draft, () => randomUUID());
      if (customHarnesses.some((item) => item.id === created.id)) {
        throw new Error(`Harness ${created.id} already exists.`);
      }
      await saveCustomHarnesses([...customHarnesses, created]);
      return { harness: created };
    },
    updateHarness: async ({ id, ...draft }) => {
      const current = customHarnesses.find((item) => item.id === id);
      if (!current) {
        if (isReservedHarnessId(id) || isRemovedHarnessId(id)) {
          throw new Error("Built-in Harnesses are immutable.");
        }
        throw new Error(`Unknown Harness ${id}.`);
      }
      const next = applyHarnessPatch(current, draft);
      await saveCustomHarnesses(
        customHarnesses.map((item) => (item.id === id ? next : item)),
      );
      return { harness: next };
    },
    deleteHarness: async ({ id }) => {
      if (isReservedHarnessId(id) || isRemovedHarnessId(id)) {
        throw new Error("Built-in Harnesses are immutable.");
      }
      if (!customHarnesses.some((item) => item.id === id)) {
        throw new Error(`Unknown Harness ${id}.`);
      }
      await saveCustomHarnesses(customHarnesses.filter((item) => item.id !== id));
      return { ok: true as const };
    },
  });

  // ---- v3 article-aligned Harness Arc (new tables, legacy rows stay readable) ----
  // registerV3Backend self-registers v3RpcContract handlers against bb.rpc.
  const v3 = registerV3Backend(bb, db, { publish, resolveProjectId, pluginId: bb.pluginId });
  v3.ensureMigratedPreset(currentRouting);

  function takeFlag(argv: string[], name: string): boolean {
    return argv.includes(name);
  }
  function takeOption(argv: string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    return argv[index + 1];
  }
  function stripFlags(argv: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i]!;
      if (arg === "--json" || arg === "--seed" || arg === "--no-seed" || arg === "--milestone" || arg === "--recovery") continue;
      if (
        arg === "--thread" ||
        arg === "--phase" ||
        arg === "--deps" ||
        arg === "--task" ||
        arg === "--node" ||
        arg === "--harness" ||
        arg === "--verdict" ||
        arg === "--summary" ||
        arg === "--artifacts" ||
        arg === "--reason"
      ) {
        i += 1;
        continue;
      }
      out.push(arg);
    }
    return out;
  }

  bb.cli.register({
    name: "harness",
    summary: "Harness for BB: opt-in Planner-led arc with an explicit implementation DAG",
    commands: [
      { name: "status", summary: "Show the v3 run (or legacy arc when no v3 run exists)", usage: "bb harness status [--thread <id>] [--json]" },
      { name: "set-phase", summary: "Advanced recovery: override the projected phase with an audit reason", usage: "bb harness set-phase <phase> --reason <text> [--thread <id>] [--json]" },
      { name: "init", summary: "Scaffold artifacts/, plans/, and HARNESS.md in the workspace", usage: "bb harness init [--thread <id>] [--json]" },
      { name: "start", summary: "Start Standard Harness by default, or a named Harness", usage: "bb harness start --task <text> [--harness <id>] [--json]" },
      { name: "stop", summary: "Cancel the active Harness run", usage: "bb harness stop [--reason <text>] [--thread <id>] [--json]" },
      { name: "plan-list", summary: "List DAG plans for the current project", usage: "bb harness plan list [--json]" },
      { name: "plan-show", summary: "Show a DAG plan", usage: "bb harness plan show <plan-id> [--json]" },
      { name: "plan-create", summary: "Create a DAG plan (seeds the five-phase arc by default)", usage: "bb harness plan create <name> [--seed|--no-seed] [--json]" },
      { name: "plan-add", summary: "Add a node to a plan", usage: "bb harness plan add <plan-id> <title> [--phase worker] [--deps id,id] [--json]" },
      { name: "plan-next", summary: "Show the next unblocked node", usage: "bb harness plan next <plan-id> [--json]" },
      { name: "plan-start", summary: "Start a node (only one in progress at a time)", usage: "bb harness plan start <plan-id> <node-id> [--json]" },
      { name: "plan-complete", summary: "Mark a node done with output evidence", usage: "bb harness plan complete <plan-id> <node-id> [--verdict APPROVE|REWORK|BLOCK] [--summary <text>] [--json]" },
      { name: "plan-reopen", summary: "(Legacy) Recovery-only Worker reopen", usage: "bb harness plan reopen <plan-id> <worker-id> --recovery --reason <text> [--json]" },
      { name: "routing", summary: "(Legacy) Show or set role routing defaults", usage: "bb harness routing [show|set <slot> <providerId> <model> [reasoning]|clear <slot>] [--json]" },
      { name: "approve-plan", summary: "Approve the Planner's proposed v3 DAG", usage: "bb harness approve-plan [--thread <id>] [--json]" },
      { name: "review-worker", summary: "Accept a Worker node or request changes", usage: "bb harness review-worker <node-id> --approve|--changes <text> [--json]" },
      { name: "review-critic", summary: "Record the operator Critic decision", usage: "bb harness review-critic --approve|--rework <node-ids> --reason <text>|--block <text> [--json]" },
      { name: "promote", summary: "Start or skip optional promotion", usage: "bb harness promote --start|--skip [--json]" },
      { name: "cancel", summary: "Cancel the v3 run after stopping role threads", usage: "bb harness cancel --reason <text> [--json]" },
      { name: "export", summary: "Export v3 artifacts and manifest", usage: "bb harness export [--thread <id>] [--json]" },
      { name: "preset", summary: "Manage v3 role presets", usage: "bb harness preset list [--json]" },
      { name: "legacy", summary: "Read-only legacy runs (v0.1/v2)", usage: "bb harness legacy list [--json]" },
    ],
    async run(argv, ctx) {
      const json = takeFlag(argv, "--json");
      const explicitThreadId = takeOption(argv, "--thread");
      const threadId = explicitThreadId ?? ctx.threadId;
      const claimedProjectId = explicitThreadId ? undefined : ctx.projectId;
      const positional = stripFlags(argv);
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`,
      });
      const fail = (message: string) => ({ exitCode: 1, stderr: `${message}\n` });
      const needThread = () => {
        if (!threadId) return fail("Pass --thread <id> or run this from a BB thread.");
        return null;
      };
      const needProject = () => {
        if (ctx.projectId) return ctx.projectId;
        return null;
      };

      const [command, ...rest] = positional;
      try {
        // v3 task-oriented commands take precedence; legacy handlers below stay
        // read-compatible and never mutate v3 state.
        if (command === "approve-plan" || command === "review-worker" || command === "review-critic" || command === "promote" || command === "cancel" || command === "export" || command === "preset" || command === "legacy") {
          const delegated = await v3.v3Cli([command, ...argv.filter((a) => a !== command)], { threadId: threadId ?? undefined, projectId: claimedProjectId ?? ctx.projectId ?? undefined });
          if (delegated) return delegated;
        }
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: `${usage()}\n` };
          case "status": {
            const missing = needThread();
            if (missing) return missing;
            const resolved = await resolveProjectId(threadId!, claimedProjectId);
            // v3 first; legacy fallback keeps old arcs/plans readable.
            try {
              const v3status = await v3.getV3Status(threadId!, resolved);
              if (v3status.run) return reply(v3status, `Harness v3: ${v3status.run.objective} (${v3status.run.id})\n${v3status.stateCopy.title}: ${v3status.stateCopy.body}`);
            } catch {}
            const status = await statusPayload(threadId!, resolved);
            return reply(status, formatStatus(status));
          }
          case "start": {
            const missing = needThread();
            if (missing) return missing;
            if (takeFlag(argv, "--milestone")) {
              return fail(removedHarnessError("milestone"));
            }
            const harnessFlag = takeOption(argv, "--harness");
            // New starts always use v3. Explicit --harness keeps legacy compat for one release.
            if (!harnessFlag) {
              const delegated = await v3.v3Cli(argv, { threadId: threadId ?? undefined, projectId: claimedProjectId ?? ctx.projectId ?? undefined });
              if (delegated) return delegated;
              return fail("start needs --task <text>");
            }
            const task = takeOption(argv, "--task") ?? rest.join(" ").trim();
            if (!task) return fail("start needs --task <text>");
            await startRun(
              {
                threadId: threadId!,
                projectId: claimedProjectId ?? undefined,
                objective: task,
                harnessId: harnessFlag,
              },
              { actor: "operator", source: "cli", requestId: `cli-start:${randomUUID()}` },
            );
            const status = await statusPayload(
              threadId!,
              await resolveProjectId(threadId!, claimedProjectId),
            );
            return reply(status, `${formatStatus(status)}\nDeprecated: legacy --harness start. New starts use v3 (bb harness start --task).`);
          }
          case "stop": {
            const missing = needThread();
            if (missing) return missing;
            const arc = requireLegacyArc(threadId!);
            const plan = activePlanForArc(arc);
            if (!plan) return fail("No active Harness plan.");
            await stopRun(
              threadId!, claimedProjectId, plan.revision,
              `cli-stop:${randomUUID()}`, takeOption(argv, "--reason") ?? "Operator cancelled from CLI.",
              { actor: "operator", source: "cli" },
            );
            const status = await statusPayload(
              threadId!,
              await resolveProjectId(threadId!, claimedProjectId),
            );
            return reply(status, formatStatus(status));
          }
          case "advance":
            return fail("Phase is derived from DAG state. Start or complete the current node instead.");
          case "rewind":
            return fail("Normal rewind is disabled. Record Critic REWORK, or use explicit recovery.");
          case "set-phase": {
            const missing = needThread();
            if (missing) return missing;
            const phase = rest[0];
            if (!phase || !isPhase(phase)) {
              return fail("set-phase needs explore|plan|worker|critic|promote");
            }
            const reason = takeOption(argv, "--reason")?.trim();
            if (!reason) return fail("set-phase is recovery-only and requires --reason <text>");
            const projectId = await resolveProjectId(threadId!, claimedProjectId);
            const arc = requireLegacyArc(threadId!);
            const plan = activePlanForArc(arc);
            if (!plan) return fail("No active Harness plan.");
            assertExpectedRevision(plan, plan.revision);
            writeArc(threadId!, projectId, phase);
            touchPlan.run(Date.now(), plan.id);
            recordMutation({
              planId: plan.id, action: "recovery.phase_set", actor: "operator", source: "cli",
              requestId: `cli-phase:${randomUUID()}`, reason, expectedRevision: plan.revision,
              detail: { phase },
            });
            const status = await statusPayload(threadId!, projectId);
            return reply(status, formatStatus(status));
          }
          case "init": {
            const missing = needThread();
            if (missing) return missing;
            const result = await initWorkspace(threadId!, claimedProjectId);
            return reply(
              result,
              [
                `Initialized ${result.path}`,
                result.written.length > 0
                  ? `Wrote: ${result.written.join(", ")}`
                  : "Wrote: (nothing new)",
                result.skipped.length > 0
                  ? `Skipped existing: ${result.skipped.join(", ")}`
                  : null,
              ]
                .filter(Boolean)
                .join("\n"),
            );
          }
          case "routing": {
            const sub = rest[0] ?? "show";
            const formatRouting = (routing: RoleRouting) =>
              ROUTING_SLOTS.map((slot) => `${slot}: ${formatChoice(routing[slot])}`).join("\n");
            if (sub === "show") {
              return reply(currentRouting, formatRouting(currentRouting));
            }
            if (sub === "set") {
              const [slot, providerId, model, reasoning] = rest.slice(1);
              if (!slot || !providerId || !model) {
                return fail("routing set needs <slot> <providerId> <model> [reasoning]. Slots: " + ROUTING_SLOTS.join(", "));
              }
              if (!isRoutingSlot(slot)) return fail(`Unknown routing slot ${slot}. Slots: ${ROUTING_SLOTS.join(", ")}`);
              const level = reasoning ?? "medium";
              if (!(REASONING_LEVELS as readonly string[]).includes(level)) {
                return fail(`Unknown reasoning level ${level}. Levels: ${REASONING_LEVELS.join(", ")}`);
              }
              try {
                // Provider ids are validated; model ids are accepted as-is because
                // the runtime host catalog is narrower than the per-environment
                // catalogs the Settings picker shows (pi routes, cursor/devin
                // models). A wrong model surfaces at spawn/send time, not here.
                const catalog = await bb.sdk.providers.models();
                const provider = catalog.providers.find((item) => item.id === providerId);
                if (!provider) {
                  return fail(`Unknown provider ${providerId}. Available: ${catalog.providers.map((item) => item.id).join(", ")}`);
                }
              } catch (error) {
                return fail(`Cannot verify provider: ${error instanceof Error ? error.message : String(error)}`);
              }
              const next = {
                ...currentRouting,
                [slot]: { providerId, model, reasoningLevel: level as ExecutionChoice["reasoningLevel"] },
              };
              await saveRouting(next);
              return reply(next, formatRouting(next));
            }
            if (sub === "clear") {
              const slot = rest[1];
              if (!slot || !isRoutingSlot(slot)) {
                return fail(`routing clear needs a slot. Slots: ${ROUTING_SLOTS.join(", ")}`);
              }
              const next = { ...currentRouting, [slot]: null };
              await saveRouting(next);
              return reply(next, formatRouting(next));
            }
            return fail(usage());
          }
          case "plan": {
            const sub = rest[0];
            const projectId = threadId
              ? await resolveProjectId(threadId, claimedProjectId)
              : needProject();
            switch (sub) {
              case "list": {
                if (!projectId) return fail("No project in context. Run this from a BB thread.");
                const rows = selectPlans.all(projectId) as PlanRow[];
                const plans = rows.map((row) => toMeta(row));
                return reply(
                  plans,
                  plans.length === 0
                    ? "No plans. Create one with bb harness plan create \"Name\" --seed"
                    : plans
                        .map(
                          (plan) =>
                            `${plan.id}  ${plan.name}  ${plan.doneCount}/${plan.nodeCount}`,
                        )
                        .join("\n"),
                );
              }
              case "show":
              case "next": {
                const id = rest[1];
                if (!id) return fail(`plan ${sub} needs a plan id`);
                await requireParentPlan(id, threadId, claimedProjectId, "read");
                const plan = await toFull(requirePlan(id));
                if (sub === "next") {
                  const next = nextWorkNode(plan.nodes);
                  return reply(
                    next,
                    next
                      ? `${next.id}  ${next.title}  (${next.phase}, ${next.status})`
                      : "No remaining nodes.",
                  );
                }
                return reply(plan, formatPlan(plan));
              }
              case "create": {
                if (!projectId) return fail("No project in context. Run this from a BB thread.");
                const name = rest.slice(1).join(" ").trim();
                if (!name) return fail("plan create needs a name");
                const now = Date.now();
                const row: PlanRow = {
                  id: shortId(),
                  project_id: projectId,
                  thread_id: threadId ?? null,
                  name,
                  created_at: now,
                  updated_at: now,
                  harness_id: STANDARD_HARNESS_ID,
                  harness_snapshot: null,
                  correction_count: 0,
                  critic_blocked: 0,
                  lifecycle: "archived",
                  revision: 0,
                };
                insertPlan.run(row);
                if (!takeFlag(argv, "--no-seed")) {
                  const frozen = snapshotHarness(standardHarnessDefinition(now));
                  insertSeedNodes(row.id, frozen);
                  persistPlanSnapshot(row.id, frozen);
                }
                publish();
                const plan = await toFull(requirePlan(row.id));
                return reply(plan, formatPlan(plan));
              }
              case "add": {
                const planId = rest[1];
                const title = rest.slice(2).join(" ").trim();
                if (!planId || !title) return fail("plan add <plan-id> <title>");
                const phaseFlag = takeOption(argv, "--phase");
                const phase = phaseFlag && isPhase(phaseFlag) ? phaseFlag : "worker";
                const deps = (takeOption(argv, "--deps") ?? "")
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean);
                await requireParentPlan(planId, threadId, claimedProjectId, "mutate");
                const current = requirePlan(planId);
                addPlanNode({
                  planId, title, phase, deps, expectedRevision: current.revision,
                  requestId: `cli-add:${randomUUID()}`,
                  attribution: { actor: "operator", source: "cli" },
                });
                publish();
                const full = await toFull(requirePlan(planId));
                return reply(full, formatPlan(full));
              }
              case "reset-block": {
                const planId = rest[1];
                if (!planId) return fail("plan reset-block <plan-id>");
                await requireParentPlan(planId, threadId, claimedProjectId, "mutate");
                const plan = requirePlan(planId);
                resetCriticBlock(planId, {
                  actor: "operator", source: "cli", requestId: `cli-reset:${randomUUID()}`,
                  reason: takeOption(argv, "--reason") ?? "Operator reset Critic block from CLI.",
                  expectedRevision: plan.revision,
                });
                const full = await toFull(requirePlan(planId));
                return reply(full, formatPlan(full));
              }
              case "start":
              case "complete":
              case "skip":
              case "reopen": {
                const planId = rest[1];
                const nodeId = rest[2];
                if (!planId || !nodeId) {
                  return fail(`plan ${sub} <plan-id> <node-id>`);
                }
                await requireParentPlan(planId, threadId, claimedProjectId, "mutate");
                const current = requirePlan(planId);
                const requestId = `cli-${sub}:${randomUUID()}`;
                if (sub === "start") {
                  const started = await startPlanNode(
                    planId, nodeId, threadId, current.revision, requestId,
                    { actor: "operator", source: "cli" },
                  );
                  return reply(started.plan, formatPlan(started.plan));
                }
                if (sub === "complete") {
                  const verdictRaw = takeOption(argv, "--verdict");
                  const verdict =
                    verdictRaw && (CRITIC_VERDICTS as readonly string[]).includes(verdictRaw)
                      ? (verdictRaw as CriticVerdict)
                      : undefined;
                  const artifacts = (takeOption(argv, "--artifacts") ?? "")
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean);
                  await withThreadLifecycle(threadId!, () =>
                    completePlanNode(
                      {
                        planId,
                        nodeId,
                        threadId: threadId!,
                        verdict,
                        summary: takeOption(argv, "--summary"),
                        artifactPaths: artifacts.length ? artifacts : undefined,
                        expectedRevision: current.revision,
                        expectedAttemptId: (selectLatestAttemptForNode.get(planId, lookupPlanNode(planId, nodeId).id) as AttemptRow | undefined)?.id ?? null,
                        requestId,
                      },
                      { actor: "operator", source: "cli" },
                    ),
                  );
                } else if (sub === "skip") {
                  await skipPlanNode(planId, nodeId, {
                    actor: "operator", source: "cli", requestId,
                    reason: takeOption(argv, "--reason") ?? "Operator skipped node from CLI.",
                    expectedRevision: current.revision,
                  });
                } else {
                  if (!takeFlag(argv, "--recovery")) {
                    return fail("plan reopen is recovery-only; pass --recovery --reason <text>");
                  }
                  const reason = takeOption(argv, "--reason")?.trim();
                  if (!reason) return fail("plan reopen requires --reason <text>");
                  await withThreadLifecycle(threadId!, () =>
                    reopenPlanNode(planId, nodeId, {
                      actor: "operator", source: "cli", requestId, reason,
                      expectedRevision: current.revision,
                    }),
                  );
                }
                const plan = await toFull(requirePlan(planId));
                return reply(plan, formatPlan(plan));
              }
              default:
                return fail(usage());
            }
          }
          default:
            return fail(usage());
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.agents.registerTool({
    name: "harness_get_arc",
    description:
      "Read this thread's harness arc (Explore/Plan/Worker/Critic/Promote), the active DAG plan, and the next node to work.",
    instructions:
      "When a harness arc is active, work the current phase and the next DAG node only. Do not skip ahead or mix critic into worker.",
    presentation: {
      label: {
        pending: "Reading harness arc",
        completed: "Read harness arc",
      },
    },
    parameters: z.object({
      threadId: z.string().optional(),
    }),
    async execute({ threadId }, ctx) {
      const id = threadId ?? ctx.threadId;
      if (!id) return "No thread id. Pass threadId or invoke inside a thread.";
      const projectId = await resolveProjectId(id, ctx.projectId ?? undefined);
      return JSON.stringify(await statusPayload(id, projectId), null, 2);
    },
  });

  bb.agents.registerTool({
    name: "harness_advance",
    description:
      "Deprecated: Harness phase is projected from DAG state; use node transitions instead.",
    presentation: {
      label: {
        pending: "Advancing harness arc",
        completed: "Advanced harness arc",
      },
    },
    parameters: z.object({
      threadId: z.string().optional(),
      phase: phaseSchema.optional(),
    }),
    async execute() {
      return "Phase is derived from DAG state. Start or complete the current node instead.";
    },
  });

  bb.agents.registerTool({
    name: "harness_create_plan",
    description:
      "Create a DAG plan for this project. Seed the five-phase arc unless seedArc is false. Add extra nodes with titles and deps.",
    presentation: {
      label: {
        pending: "Creating harness plan",
        completed: "Created harness plan",
      },
    },
    parameters: z.object({
      name: z.string().trim().min(1).max(200),
      seedArc: z.boolean().optional(),
      nodes: z
        .array(
          z.object({
            title: z.string().trim().min(1).max(200),
            detail: z.string().max(2000).optional(),
            phase: phaseSchema.optional(),
            deps: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    }),
    async execute({ name, seedArc, nodes }, ctx) {
      if (!ctx.projectId) return "No project in context.";
      const now = Date.now();
      const row: PlanRow = {
        id: shortId(),
        project_id: ctx.projectId,
        thread_id: ctx.threadId ?? null,
        name,
        created_at: now,
        updated_at: now,
        harness_id: STANDARD_HARNESS_ID,
        harness_snapshot: null,
        correction_count: 0,
        critic_blocked: 0,
        lifecycle: "archived",
        revision: 0,
      };
      insertPlan.run(row);
      if (seedArc !== false) {
        const frozen = snapshotHarness(standardHarnessDefinition(now));
        insertSeedNodes(row.id, frozen);
        persistPlanSnapshot(row.id, frozen);
      }
      for (const node of nodes ?? []) {
        addPlanNode({
          planId: row.id,
          title: node.title,
          detail: node.detail,
          phase: node.phase,
          deps: node.deps,
        });
      }
      publish();
      return JSON.stringify(await toFull(requirePlan(row.id)), null, 2);
    },
  });

  bb.agents.registerTool({
    name: "harness_next_node",
    description:
      "Start the next unblocked DAG node (only one node in progress). Pass planId from harness_get_arc or plan create.",
    presentation: {
      label: {
        pending: "Starting next harness node",
        completed: "Started next harness node",
      },
    },
    parameters: z.object({
      planId: z.string(),
      nodeId: z.string().optional(),
    }),
    async execute({ planId, nodeId }, ctx) {
      await requireParentPlan(planId, ctx.threadId, ctx.projectId, "mutate");
      const nodes = nodesOf(planId);
      const target = nodeId
        ? lookupPlanNode(planId, nodeId)
        : nextWorkNode(nodes);
      if (!target) return "No remaining unblocked nodes.";
      try {
        const plan = requirePlan(planId);
        const started = await startPlanNode(
          planId, target.id, ctx.threadId, plan.revision, `tool-start:${randomUUID()}`,
          { actor: "parent-agent", source: "harness_next_node" },
        );
        const current = started.plan.nodes.find((node) => node.id === target.id);
        return JSON.stringify({
          planId,
          revision: started.plan.revision,
          started: current
            ? { id: current.id, phase: current.phase, status: current.status, childThreadId: current.childThreadId, attemptId: current.attempt?.id ?? null }
            : { id: target.id },
        });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "harness_complete_node",
    description:
      "Mark a DAG node done. Critic nodes require verdict APPROVE, REWORK, or BLOCK plus a summary.",
    presentation: {
      label: {
        pending: "Completing harness node",
        completed: "Completed harness node",
      },
    },
    parameters: completeNodeInputSchema
      .omit({ threadId: true, requestId: true, expectedAttemptId: true })
      .extend({ expectedRevision: z.number().int().nonnegative().optional() }),
    async execute(input, ctx) {
      if (!ctx.threadId) {
        return "Invoke this tool from the parent thread that owns the plan.";
      }
      await requireParentPlan(input.planId, ctx.threadId, ctx.projectId, "mutate");
      const ownerPlan = requirePlan(input.planId);
      const node = lookupPlanNode(input.planId, input.nodeId);
      const attempt = selectLatestAttemptForNode.get(input.planId, node.id) as AttemptRow | undefined;
      const completed = await withThreadLifecycle(ctx.threadId, () =>
        completePlanNode(
          {
            ...input,
            threadId: ctx.threadId!,
            expectedRevision: input.expectedRevision ?? ownerPlan.revision,
            requestId: `tool-complete:${randomUUID()}`,
            expectedAttemptId: attempt?.id ?? null,
          },
          { actor: "parent-agent", source: "harness_complete_node" },
        ),
      );
      const plan = await toFull(requirePlan(input.planId));
      const next = nextWorkNode(plan.nodes);
      return JSON.stringify({
        planId: plan.id,
        revision: plan.revision,
        completed: completed.id,
        next: next ? { id: next.id, phase: next.phase, status: next.status } : null,
      });
    },
  });

  function liveChildNode(threadId: string): PlanNode | null {
    const child = selectNodeByChild.get(threadId) as NodeRow | undefined;
    if (!child) return null;
    const node = toNode(child);
    if (node.status !== "in_progress" && node.status !== "starting") return null;
    const plan = selectPlan.get(child.plan_id) as PlanRow | undefined;
    if (!plan?.thread_id) return null;
    const arc = readArc(plan.thread_id);
    if (!arc) return null;
    const active = activePlanForArc(arc);
    if (!active || active.id !== plan.id) return null;
    return node;
  }

  function parentExecutionInstructions(threadId: string): string | null {
    const owner = ownerThreadId(threadId);
    const arc = readArc(owner);
    if (!arc) return null;
    const storedPhase = isPhase(arc.phase) ? arc.phase : "explore";
    const plan = activePlanForArc(arc);
    const phase = plan ? nextWorkNode(nodesOf(plan.id))?.phase ?? storedPhase : storedPhase;
    if (plan) {
      const inflight = activeNode(nodesOf(plan.id));
      if (inflight && !nodeSpawnsChild(inflight)) {
        return nodePrompt(inflight, inflight.phase);
      }
      const snapshot = snapshotOf(plan);
      const spec = snapshot?.phases[phase];
      if (spec && spec.execution === "parent") {
        return nodePrompt(
          {
            id: `${plan.id}-${phase}`,
            title: spec.title,
            detail: spec.detail,
            phase,
            status: "pending",
            deps: [],
            sortOrder: 0,
          },
          phase,
        );
      }
    }
    return [
      `You are on the ${PHASE_COPY[phase].label} phase of an explicit Harness.`,
      PHASE_COPY[phase].summary,
      "Explore and Plan stay on this parent thread unless a frozen custom definition sets child execution.",
      "Worker, Critic, and Promote spawn visible children by default.",
      "The parent operator records Critic APPROVE, REWORK, or BLOCK.",
      "Work one DAG node at a time.",
    ].join(" ");
  }

  // ---- v3 role-specific agent tools (Planner/Worker/Critic/Promoter isolation) ----
  const v3RunRow = (threadId: string): { id: string; state: string; planner_thread_id: string | null } | null => {
    try {
      const info = v3.isV3RoleThread(threadId);
      if (!info) return null;
      return db.prepare("SELECT id, state, planner_thread_id FROM harness_v3_runs WHERE id = ?").get(info.runId) as never;
    } catch { return null; }
  };
  const requireV3Role = (threadId: string, roles: string[]): { runId: string; role: string; nodeId: string | null } => {
    const info = v3.isV3RoleThread(threadId);
    if (!info || !roles.includes(info.role)) {
      throw new Error(`This tool is restricted to ${roles.join("/")} role threads for the live attempt.`);
    }
    return info;
  };
  type V3RunLite = {
    id: string; state: string;
    planner_thread_id: string | null; explorer_thread_id: string | null;
    critic_thread_id: string | null; promoter_thread_id: string | null;
    active_worker_node_id: string | null; active_worker_thread_id: string | null;
    home_thread_id: string; project_id: string;
  };
  const v3RunLite = (runId: string): V3RunLite => {
    const row = db.prepare("SELECT * FROM harness_v3_runs WHERE id = ?").get(runId) as V3RunLite | undefined;
    if (!row) throw new Error("Run not found.");
    return row;
  };
  // Exact live-attempt gate: the caller must be the run's CURRENT thread for
  // that role (and node). Superseded threads — after retry, accept, or a new
  // spawn — no longer match and are rejected.
  const requireCurrentRoleThread = (
    threadId: string, runId: string,
    role: "planner" | "explorer" | "worker" | "critic" | "promoter",
    nodeId?: string | null,
  ): string => {
    const run = v3RunLite(runId);
    const expected =
      role === "planner" ? run.planner_thread_id
      : role === "explorer" ? run.explorer_thread_id
      : role === "critic" ? run.critic_thread_id
      : role === "promoter" ? run.promoter_thread_id
      : run.active_worker_thread_id;
    if (!expected || expected !== threadId) {
      throw new Error(`This tool is restricted to the live ${role} thread for the current attempt. This thread was superseded (retry, accept, or a newer spawn).`);
    }
    if (role === "worker" && nodeId && run.active_worker_node_id !== nodeId) {
      throw new Error("This Worker thread is not assigned to that node.");
    }
    const attempt = db.prepare("SELECT id FROM harness_v3_attempts WHERE child_thread_id = ? ORDER BY started_at DESC LIMIT 1").get(threadId) as { id: string } | undefined;
    if (!attempt) throw new Error("No attempt record for this thread.");
    return attempt.id;
  };
  // One structured report per attempt: a second submit from the same attempt
  // is a replay, not new evidence.
  const rejectIfAttemptReported = (attemptId: string): void => {
    const existing = db.prepare("SELECT id FROM harness_v3_reports WHERE attempt_id = ? LIMIT 1").get(attemptId) as { id: string } | undefined;
    if (existing) throw new Error("This attempt already submitted its structured report. Retry the role for a new attempt.");
  };
  bb.agents.registerTool({
    name: "harness_get_run_context",
    description: "Planner-only: read the authoritative v3 run context packet.",
    parameters: z.object({}),
    async execute(_input, ctx) {
      if (!ctx.threadId) return "Invoke inside a thread.";
      const info = requireV3Role(ctx.threadId, ["planner"]);
      requireCurrentRoleThread(ctx.threadId, info.runId, "planner");
      const slice = await v3.packetSliceFor(info.runId, "planner", null);
      return JSON.stringify(slice, null, 2);
    },
  });
  bb.agents.registerTool({
    name: "harness_run_explorer",
    description: "Planner-only: dispatch Explorer as a child of Planner. The structured report is delivered to this thread agent-only on submit; idle output is a fallback. Use the panel Run Explorer action if dispatch fails.",
    parameters: z.object({ questions: z.array(z.string().max(1000)).max(12).optional() }),
    async execute({ questions }, ctx) {
      if (!ctx.threadId) return "Invoke inside a thread.";
      const info = requireV3Role(ctx.threadId, ["planner"]);
      const run = db.prepare("SELECT * FROM harness_v3_runs WHERE id = ?").get(info.runId) as { home_thread_id: string };
      try {
        await v3.handlers.v3RunExplorer({ threadId: run.home_thread_id, questions } as never);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      return "Explorer dispatched as a child of Planner. Its structured report will be stored via harness_submit_exploration; idle output is a fallback, never silent success. Use the panel Run Explorer action if this tool cannot complete.";
    },
  });
  bb.agents.registerTool({
    name: "harness_submit_plan_draft",
    description: "Planner-only: propose the implementation DAG. Cannot approve it.",
    parameters: z.object({ nodes: z.array(z.object({
      title: z.string(), objective: z.string(), dependencies: z.array(z.string()).optional(),
      acceptanceCriteria: z.array(z.string()), verificationCommands: z.array(z.string()).optional(),
      expectedArtifacts: z.array(z.string()).optional(), skillHints: z.array(z.string()).optional(),
      phase: z.string().optional(),
    })).min(1).max(64) }),
    async execute({ nodes }, ctx) {
      if (!ctx.threadId) return "Invoke inside a thread.";
      const info = requireV3Role(ctx.threadId, ["planner"]);
      try {
        requireCurrentRoleThread(ctx.threadId, info.runId, "planner");
      } catch (e) { return e instanceof Error ? e.message : String(e); }
      try {
        const out = await submitPlanDraftFromTool({ db: db as never, runId: info.runId, drafts: nodes, actor: "planner", requestId: `tool:draft:${randomUUID()}`, update: false });
        return JSON.stringify({ draftRevision: out.revision, nodeIds: out.nodes.map((n) => n.id) });
      } catch (e) { return e instanceof Error ? e.message : String(e); }
    },
  });
  bb.agents.registerTool({
    name: "harness_update_plan_draft",
    description: "Planner-only: replace the proposed DAG before operator approval.",
    parameters: z.object({ nodes: z.array(z.object({
      title: z.string(), objective: z.string(), dependencies: z.array(z.string()).optional(),
      acceptanceCriteria: z.array(z.string()), verificationCommands: z.array(z.string()).optional(),
      expectedArtifacts: z.array(z.string()).optional(), skillHints: z.array(z.string()).optional(),
      phase: z.string().optional(),
    })).min(1).max(64) }),
    async execute({ nodes }, ctx) {
      if (!ctx.threadId) return "Invoke inside a thread.";
      const info = requireV3Role(ctx.threadId, ["planner"]);
      try {
        requireCurrentRoleThread(ctx.threadId, info.runId, "planner");
      } catch (e) { return e instanceof Error ? e.message : String(e); }
      try {
        const out = await submitPlanDraftFromTool({ db: db as never, runId: info.runId, drafts: nodes, actor: "planner", requestId: `tool:update:${randomUUID()}`, update: true });
        return JSON.stringify({ draftRevision: out.revision, nodeIds: out.nodes.map((n) => n.id) });
      } catch (e) { return e instanceof Error ? e.message : String(e); }
    },
  });
  bb.agents.registerTool({
    name: "harness_get_node_context",
    description: "Worker-only: read the bounded packet slice for the current node.",
    parameters: z.object({}),
    async execute(_input, ctx) {
      if (!ctx.threadId) return "Invoke inside a thread.";
      const info = requireV3Role(ctx.threadId, ["workerFirst", "workerRest"]);
      if (!info.nodeId) return "No current node for this Worker thread.";
      requireCurrentRoleThread(ctx.threadId, info.runId, "worker", info.nodeId);
      const slice = await v3.packetSliceFor(info.runId, "worker", info.nodeId);
      return JSON.stringify(slice, null, 2);
    },
  });
  bb.agents.registerTool({
    name: "harness_submit_worker_report",
    description: "Worker-only: submit the structured report for the caller attempt.",
    parameters: z.object({
      outcome: z.enum(["complete", "blocked", "plan-change-needed"]),
      summary: z.string().min(1).max(8000),
      changedFiles: z.array(z.string()).optional(),
      acceptanceResults: z.array(z.object({ criterion: z.string(), met: z.boolean(), note: z.string().optional() })).optional(),
      commands: z.array(z.object({ command: z.string(), exitCode: z.number().nullable().optional(), output: z.string().optional() })).optional(),
      artifactRefs: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
    }),
    async execute(input, ctx) {
      if (!ctx.threadId) return "Invoke inside a thread.";
      const info = requireV3Role(ctx.threadId, ["workerFirst", "workerRest"]);
      if (!info.nodeId) return "No current node for this Worker thread.";
      const parsed = validateWorkerReport(input);
      if (!parsed.ok) return parsed.error;
      for (const p of parsed.report.artifactRefs) { if (!isSafeV3ArtifactRef(p)) return `Unsafe artifact path ${p}. Must stay under artifacts/.`; }
      let attemptId: string;
      try {
        attemptId = requireCurrentRoleThread(ctx.threadId, info.runId, "worker", info.nodeId);
        rejectIfAttemptReported(attemptId);
      } catch (e) { return e instanceof Error ? e.message : String(e); }
      db.prepare("INSERT INTO harness_v3_reports (id, run_id, node_id, kind, payload_json, attempt_id, created_at) VALUES (?, ?, ?, 'worker', ?, ?, ?)").run(randomUUID(), info.runId, info.nodeId, JSON.stringify({ ...parsed.report, nodeId: info.nodeId }), attemptId, Date.now());
      db.prepare("UPDATE harness_v3_work_nodes SET status = 'awaiting_review' WHERE run_id = ? AND node_id = ?").run(info.runId, info.nodeId);
      db.prepare("UPDATE harness_v3_attempts SET status = 'idle_with_output', output_hash = ?, ended_at = ? WHERE id = ?").run(createHash("sha256").update(parsed.report.summary).digest("hex"), Date.now(), attemptId);
      publish();
      return "Worker report stored. The operator reviews and accepts; you cannot approve yourself.";
    },
  });
  bb.agents.registerTool({
    name: "harness_get_review_context",
    description: "Critic-only: read objective, plan, Worker reports, and checks.",
    parameters: z.object({}),
    async execute(_input, ctx) {
      if (!ctx.threadId) return "Invoke inside a thread.";
      const info = requireV3Role(ctx.threadId, ["critic"]);
      requireCurrentRoleThread(ctx.threadId, info.runId, "critic");
      const slice = await v3.packetSliceFor(info.runId, "critic", null);
      return JSON.stringify(slice, null, 2);
    },
  });
  bb.agents.registerTool({
    name: "harness_submit_critic_report",
    description: "Critic-only: recommend APPROVE, REWORK, or BLOCK.",
    parameters: z.object({
      recommendation: z.enum(["APPROVE", "REWORK", "BLOCK"]),
      findings: z.array(z.object({ severity: z.enum(["high", "medium", "low"]), title: z.string(), detail: z.string().optional() })).optional(),
      affectedNodeIds: z.array(z.string()).optional(),
      checksRerun: z.array(z.object({ command: z.string(), exitCode: z.number().nullable().optional(), note: z.string().optional() })).optional(),
      unsupportedClaims: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
    }),
    async execute(input, ctx) {
      if (!ctx.threadId) return "Invoke inside a thread.";
      const info = requireV3Role(ctx.threadId, ["critic"]);
      const parsed = validateCriticReport(input);
      if (!parsed.ok) return parsed.error;
      let attemptId: string;
      try {
        attemptId = requireCurrentRoleThread(ctx.threadId, info.runId, "critic");
        rejectIfAttemptReported(attemptId);
      } catch (e) { return e instanceof Error ? e.message : String(e); }
      db.prepare("INSERT INTO harness_v3_reports (id, run_id, node_id, kind, payload_json, attempt_id, created_at) VALUES (?, ?, NULL, 'critic', ?, ?, ?)").run(randomUUID(), info.runId, JSON.stringify(parsed.report), attemptId, Date.now());
      db.prepare("UPDATE harness_v3_attempts SET status = 'idle_with_output', ended_at = ? WHERE id = ?").run(Date.now(), attemptId);
      db.prepare("UPDATE harness_v3_runs SET state = 'FinalReview', revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), info.runId);
      publish();
      return `Critic ${parsed.report.recommendation} recorded. Only the operator decides.`;
    },
  });
  bb.agents.registerTool({
    name: "harness_submit_exploration",
    description: "Explorer-only: submit the structured exploration report.",
    parameters: z.object({
      summary: z.string().min(1).max(8000),
      findings: z.array(z.string()).optional(),
      suggestedNodes: z.array(z.object({ title: z.string(), objective: z.string(), dependencies: z.array(z.string()).optional(), acceptanceCriteria: z.array(z.string()), verificationCommands: z.array(z.string()).optional(), expectedArtifacts: z.array(z.string()).optional(), skillHints: z.array(z.string()).optional() })).optional(),
      risks: z.array(z.string()).optional(),
      artifactRefs: z.array(z.string()).optional(),
    }),
    async execute(input, ctx) {
      if (!ctx.threadId) return "Invoke inside a thread.";
      const info = requireV3Role(ctx.threadId, ["explorer"]);
      const parsed = validateExplorationReport(input);
      if (!parsed.ok) return parsed.error;
      let attemptId: string;
      try {
        attemptId = requireCurrentRoleThread(ctx.threadId, info.runId, "explorer");
        rejectIfAttemptReported(attemptId);
      } catch (e) { return e instanceof Error ? e.message : String(e); }
      db.prepare("INSERT INTO harness_v3_reports (id, run_id, node_id, kind, payload_json, attempt_id, created_at) VALUES (?, ?, NULL, 'exploration', ?, ?, ?)").run(randomUUID(), info.runId, JSON.stringify({ ...parsed.report, createdAt: Date.now() }), attemptId, Date.now());
      db.prepare("UPDATE harness_v3_attempts SET status = 'idle_with_output', ended_at = ? WHERE id = ?").run(Date.now(), attemptId);
      publish();
      // Deliver the findings to the Planner thread so the report actually
      // reaches Planner context (best-effort; the panel always shows it).
      await v3.deliverExplorationToPlanner(info.runId, parsed.report.summary, parsed.report.findings);
      return "Exploration stored and delivered to Planner context.";
    },
  });
  bb.agents.registerTool({
    name: "harness_get_promotion_context",
    description: "Promoter-only: read verified result and approved claims.",
    parameters: z.object({}),
    async execute(_input, ctx) {
      if (!ctx.threadId) return "Invoke inside a thread.";
      const info = requireV3Role(ctx.threadId, ["promoter"]);
      requireCurrentRoleThread(ctx.threadId, info.runId, "promoter");
      const slice = await v3.packetSliceFor(info.runId, "promoter", null);
      return JSON.stringify(slice, null, 2);
    },
  });
  bb.agents.registerTool({
    name: "harness_submit_promotion",
    description: "Promoter-only: submit the communication report.",
    parameters: z.object({
      audience: z.string().max(500).optional(), channel: z.string().max(500).optional(),
      summary: z.string().min(1).max(8000), claims: z.array(z.string()).optional(),
      limitations: z.array(z.string()).optional(), artifactRefs: z.array(z.string()).optional(),
    }),
    async execute(input, ctx) {
      if (!ctx.threadId) return "Invoke inside a thread.";
      const info = requireV3Role(ctx.threadId, ["promoter"]);
      const parsed = validatePromotionReport(input);
      if (!parsed.ok) return parsed.error;
      let attemptId: string;
      try {
        attemptId = requireCurrentRoleThread(ctx.threadId, info.runId, "promoter");
        rejectIfAttemptReported(attemptId);
      } catch (e) { return e instanceof Error ? e.message : String(e); }
      db.prepare("INSERT INTO harness_v3_reports (id, run_id, node_id, kind, payload_json, attempt_id, created_at) VALUES (?, ?, NULL, 'promotion', ?, ?, ?)").run(randomUUID(), info.runId, JSON.stringify(parsed.report), attemptId, Date.now());
      db.prepare("UPDATE harness_v3_attempts SET status = 'idle_with_output', ended_at = ? WHERE id = ?").run(Date.now(), attemptId);
      publish();
      return "Promotion stored. The operator marks completion.";
    },
  });

  bb.agents.configure((context) => {
    // Thread title + origin feed the pre-spawn intent fallback: only a child
    // spawned by this plugin with the exact pending title resolves a role
    // before its attempt mapping is persisted.
    const v3info = v3.isV3RoleThread(context.thread.id, {
      parentThreadId: context.thread.parentThreadId,
      title: context.thread.title,
      originPluginId: context.origin?.pluginId,
    });
    if (v3info) {
      const roleTools: Record<string, string[]> = {
        planner: ["harness_get_run_context", "harness_run_explorer", "harness_submit_plan_draft", "harness_update_plan_draft"],
        explorer: ["harness_submit_exploration"],
        workerFirst: ["harness_get_node_context", "harness_submit_worker_report"],
        workerRest: ["harness_get_node_context", "harness_submit_worker_report"],
        critic: ["harness_get_review_context", "harness_submit_critic_report"],
        promoter: ["harness_get_promotion_context", "harness_submit_promotion"],
      };
      const roleSkills: Record<string, string[]> = {
        planner: ["harness-planner"],
        explorer: [],
        workerFirst: ["harness-worker"],
        workerRest: ["harness-worker"],
        critic: ["harness-critic"],
        promoter: ["harness-promoter"],
      };
      const roleInstructions: Record<string, string> = {
        planner: "You are the Harness Planner. Workspace instructions remain authoritative. Propose an implementation-only DAG via harness_submit_plan_draft. You cannot approve it.",
        explorer: "You are the Harness Explorer. Investigate only; submit via harness_submit_exploration.",
        workerFirst: "You are a Harness Worker. Implement exactly your node; report via harness_submit_worker_report. Do not self-approve.",
        workerRest: "You are a Harness Worker. Implement exactly your node; report via harness_submit_worker_report. Do not self-approve.",
        critic: "You are the Harness Critic. Recommend APPROVE/REWORK/BLOCK via harness_submit_critic_report. You cannot decide.",
        promoter: "You are the Harness Promoter. Communicate only verified claims via harness_submit_promotion.",
      };
      return {
        tools: roleTools[v3info.role] ?? [],
        skills: roleSkills[v3info.role] ?? [],
        instructions: roleInstructions[v3info.role] ?? "",
      };
    }
    const child = liveChildNode(context.thread.id);
    if (child) {
      return {
        tools: ["harness_get_arc"],
        skills: [PLUGIN_SKILL_NAME],
        instructions: nodePrompt(child, child.phase),
      };
    }
    const owner = ownerThreadId(context.thread.id);
    const arc = readArc(owner);
    if (arc) {
      return {
        tools: [
          "harness_get_arc",
          "harness_create_plan",
          "harness_next_node",
          "harness_complete_node",
        ],
        skills: [PLUGIN_SKILL_NAME],
        instructions: parentExecutionInstructions(context.thread.id) ?? "",
      };
    }
    return { tools: [], skills: [] };
  });


  const refreshChild = ({ thread }: { thread: { id: string } }) => {
    const row = selectNodeByChild.get(thread.id) as NodeRow | undefined;
    if (row) publish();
  };
  bb.events.on("thread.idle", (payload) => {
    const output = payload.lastAssistantText?.trim();
    const outputHash = output
      ? createHash("sha256").update(output).digest("hex")
      : null;
    void closeAttemptForChild(
      payload.thread.id,
      outputHash ? "idle_with_output" : "idle_empty",
      outputHash,
    ).then(() => refreshChild(payload));
  });
  // v3 recovery: reconcile role threads that became idle/failed/archived without a structured report.
  const v3Touch = (threadId: string) => {
    try {
      if (v3.isV3RoleThread(threadId)) publish();
    } catch {}
  };
  bb.events.on("thread.idle", (payload) => {
    const id = payload.thread.id;
    const info = (() => { try { return v3.isV3RoleThread(id); } catch { return null; } })();
    if (!info) return;
    void (async () => {
      const { text, hash } = await readThreadOutput(bb, id);
      let tokensJson: string | null = null;
      try {
        const tokens = await readChildTokens(id);
        if (tokens) tokensJson = JSON.stringify(tokens);
      } catch {}
      try {
        if (tokensJson) {
          db.prepare("UPDATE harness_v3_attempts SET status = ?, output_hash = COALESCE(?, output_hash), tokens_json = ?, ended_at = COALESCE(ended_at, ?) WHERE child_thread_id = ? AND ended_at IS NULL").run(
            hash ? "idle_with_output" : "idle_empty", hash, tokensJson, Date.now(), id,
          );
        } else {
          db.prepare("UPDATE harness_v3_attempts SET status = ?, output_hash = COALESCE(?, output_hash), ended_at = COALESCE(ended_at, ?) WHERE child_thread_id = ? AND ended_at IS NULL").run(
            hash ? "idle_with_output" : "idle_empty", hash, Date.now(), id,
          );
        }
      } catch {}
      // Worker idle without a structured report stays awaiting operator review;
      // never silently completes. Operator can retry or accept with warning.
      if (text && info.nodeId) {
        try {
          db.prepare("UPDATE harness_v3_work_nodes SET status = 'awaiting_review' WHERE run_id = ? AND node_id = ? AND status = 'running'").run(info.runId, info.nodeId);
        } catch {}
      }
      v3Touch(id);
    })();
  });
  bb.events.on("thread.failed", (payload) => {
    const id = payload.thread.id;
    const info = (() => { try { return v3.isV3RoleThread(id); } catch { return null; } })();
    if (info) {
      void (async () => {
        try {
          const run = db.prepare("SELECT * FROM harness_v3_runs WHERE id = ?").get(info.runId) as {
            state: string; planner_thread_id: string | null; explorer_thread_id: string | null;
            critic_thread_id: string | null; promoter_thread_id: string | null;
            active_worker_node_id: string | null; active_worker_thread_id: string | null;
          } | undefined;
          // Stale threads (already superseded by retry/accept/respawn) reconcile nothing.
          if (!run) return;
          const current =
            info.role === "planner" ? run.planner_thread_id
            : info.role === "explorer" ? run.explorer_thread_id
            : info.role === "critic" ? run.critic_thread_id
            : info.role === "promoter" ? run.promoter_thread_id
            : run.active_worker_thread_id;
          if (current !== id) return;
          db.prepare("UPDATE harness_v3_attempts SET status = 'failed', ended_at = ? WHERE child_thread_id = ? AND ended_at IS NULL").run(Date.now(), id);
          if (info.role === "workerFirst" || info.role === "workerRest") {
            // Back to a recoverable Executing: node re-queued, worker pointer
            // kept on the node (thread cleared) so Retry targets the right node.
            if (info.nodeId) {
              db.prepare("UPDATE harness_v3_work_nodes SET status = 'pending', attempt_id = NULL WHERE run_id = ? AND node_id = ? AND status IN ('running','awaiting_review')").run(info.runId, info.nodeId);
            }
            db.prepare("UPDATE harness_v3_runs SET active_worker_thread_id = NULL, state = 'Executing', revision = revision + 1, updated_at = ? WHERE id = ? AND state = 'WorkerReview'").run(Date.now(), info.runId);
            db.prepare("UPDATE harness_v3_runs SET active_worker_thread_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND active_worker_thread_id = ?").run(Date.now(), info.runId, id);
          } else if (info.role === "explorer") {
            db.prepare("UPDATE harness_v3_runs SET explorer_thread_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), info.runId);
          } else if (info.role === "critic") {
            db.prepare("UPDATE harness_v3_runs SET critic_thread_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), info.runId);
          } else if (info.role === "promoter") {
            db.prepare("UPDATE harness_v3_runs SET promoter_thread_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), info.runId);
          }
          // Planner keeps its thread id so the failure stays visible; operator
          // retries via v3RetryRole(planner), which respawns the thread.
        } catch {}
        v3Touch(id);
      })();
    }
  });
  bb.events.on("thread.active", refreshChild);
  bb.events.on("thread.failed", (payload) => {
    void reconcileFailedChild(payload.thread.id).then(() => refreshChild(payload));
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
