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
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  PHASES,
  PHASE_COPY,
  REASONING_LEVELS,
  ROUTING_SLOTS,
  activeNode,
  formatChoice,
  isPhase,
  isNodeStatus,
  isRoutingSlot,
  nextPhase,
  nextWorkNode,
  nodeChoice,
  nodeSpawnsChild,
  parseDeps,
  parseRoleRouting,
  previousPhase,
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
  createdAt: z.number(),
});
const nodeAttemptSchema = z.object({
  id: z.string(),
  childThreadId: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  tokens: tokenCountersSchema,
  source: z.string(),
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
});

const planTotalsSchema = z.object({
  durationMs: z.number().nullable(),
  tokens: tokenCountersSchema,
});

const planFullSchema = planMetaSchema.extend({
  nodes: z.array(planNodeSchema),
  harnessSnapshot: harnessDefinitionSchema.nullable(),
  totals: planTotalsSchema,
  skillWarnings: z.array(z.string()),
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
    }).merge(planAccessSchema),
    output: z.object({ plan: planFullSchema }),
  },
  startNode: {
    input: z.object({
      planId: z.string(),
      nodeId: z.string(),
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
    input: z.object({ planId: z.string(), nodeId: z.string() }).merge(planAccessSchema),
    output: z.object({ plan: planFullSchema }),
  },
  reopenNode: {
    input: z.object({ planId: z.string(), nodeId: z.string() }).merge(planAccessSchema),
    output: z.object({ plan: planFullSchema }),
  },
  resetCriticBlock: {
    input: z.object({ planId: z.string() }).merge(planAccessSchema),
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
  created_at: number;
};

type AttemptRow = {
  id: string;
  plan_id: string;
  node_id: string;
  child_thread_id: string | null;
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
    "Usage:",
    "  bb harness status [--thread <id>] [--json]",
    "  bb harness advance [--thread <id>] [--json]",
    "  bb harness rewind [--thread <id>] [--json]",
    "  bb harness set-phase <explore|plan|worker|critic|promote> [--thread <id>] [--json]",
    "  bb harness start --task <text> [--harness <id>] [--thread <id>] [--json]",
    "  bb harness stop [--thread <id>] [--json]",
    "  bb harness plan list [--json]",
    "  bb harness plan show <plan-id> [--json]",
    "  bb harness plan create <name> [--seed] [--no-seed] [--thread <id>] [--json]",
    "  bb harness plan add <plan-id> <title> [--phase <phase>] [--deps id,id] [--json]",
    "  bb harness plan next <plan-id> [--json]",
    "  bb harness plan start <plan-id> <node-id> [--json]",
    "  bb harness plan complete <plan-id> <node-id> [--verdict APPROVE|REWORK|BLOCK] [--summary <text>] [--json]",
    "  bb harness plan reset-block <plan-id> [--json]",
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
  ]);

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
    `INSERT INTO arcs (thread_id, project_id, phase, note, updated_at, harness_id)
     VALUES (@thread_id, @project_id, @phase, @note, @updated_at, @harness_id)`,
  );
  const upsertArc = db.prepare(
    `INSERT INTO arcs (thread_id, project_id, phase, note, updated_at, harness_id)
     VALUES (@thread_id, @project_id, @phase, @note, @updated_at, @harness_id)
     ON CONFLICT(thread_id) DO UPDATE SET
       project_id = excluded.project_id,
       phase = excluded.phase,
       note = excluded.note,
       updated_at = excluded.updated_at,
       harness_id = excluded.harness_id`,
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
  const insertPlan = db.prepare(
    `INSERT INTO plans (id, project_id, thread_id, name, created_at, updated_at, harness_id, harness_snapshot, correction_count, critic_blocked)
     VALUES (@id, @project_id, @thread_id, @name, @created_at, @updated_at, @harness_id, @harness_snapshot, @correction_count, @critic_blocked)`,
  );
  const touchPlan = db.prepare(
    "UPDATE plans SET updated_at = ? WHERE id = ?",
  );
  const updatePlanSnapshot = db.prepare(
    "UPDATE plans SET harness_id = ?, harness_snapshot = ?, updated_at = ? WHERE id = ?",
  );
  const updatePlanFlags = db.prepare(
    "UPDATE plans SET correction_count = ?, critic_blocked = ?, updated_at = ? WHERE id = ?",
  );
  const selectNodes = db.prepare(
    "SELECT * FROM plan_nodes WHERE plan_id = ? ORDER BY sort_order ASC",
  );
  const insertNode = db.prepare(
    `INSERT INTO plan_nodes (id, plan_id, title, detail, phase, status, deps, sort_order, execution, skills)
     VALUES (@id, @plan_id, @title, @detail, @phase, @status, @deps, @sort_order, @execution, @skills)`,
  );
  const updateNodeStatus = db.prepare(
    "UPDATE plan_nodes SET status = ? WHERE id = ? AND plan_id = ?",
  );
  const claimNodeStatus = db.prepare(
    "UPDATE plan_nodes SET status = ? WHERE id = ? AND plan_id = ? AND status = ?",
  );
  const recoverStartingNode = db.prepare(
    `UPDATE plan_nodes
     SET status = 'pending'
     WHERE id = ? AND plan_id = ? AND status = 'starting' AND child_thread_id IS NULL`,
  );
  const attachStartingChild = db.prepare(
    `UPDATE plan_nodes
     SET status = 'in_progress', child_thread_id = ?
     WHERE id = ? AND plan_id = ? AND status = 'starting'`,
  );
  const casFailedChild = db.prepare(
    `UPDATE plan_nodes
     SET status = 'pending', child_thread_id = NULL
     WHERE id = ? AND plan_id = ? AND status = 'in_progress' AND child_thread_id = ?`,
  );
  const selectNodeByChild = db.prepare(
    "SELECT * FROM plan_nodes WHERE child_thread_id = ?",
  );
  const updateNodeChild = db.prepare(
    "UPDATE plan_nodes SET child_thread_id = ? WHERE id = ? AND plan_id = ?",
  );
  const updateNodeChoice = db.prepare(
    `UPDATE plan_nodes
     SET provider_id = ?, model = ?, reasoning_level = ?, service_tier = ?
     WHERE id = ? AND plan_id = ?`,
  );
  const resetPlanNode = db.prepare(
    `UPDATE plan_nodes
     SET status = ?, child_thread_id = NULL
     WHERE id = ? AND plan_id = ?`,
  );
  const selectAllNodeIds = db.prepare("SELECT id FROM plan_nodes");
  const insertResult = db.prepare(
    `INSERT INTO plan_node_results (id, plan_id, node_id, verdict, summary, artifact_paths, actor, source, created_at)
     VALUES (@id, @plan_id, @node_id, @verdict, @summary, @artifact_paths, @actor, @source, @created_at)`,
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
       id, plan_id, node_id, child_thread_id, provider_id, model, started_at, ended_at,
       duration_ms, tokens_input, tokens_cached, tokens_output, tokens_reasoning, tokens_total, source, created_at
     ) VALUES (
       @id, @plan_id, @node_id, @child_thread_id, @provider_id, @model, @started_at, @ended_at,
       @duration_ms, @tokens_input, @tokens_cached, @tokens_output, @tokens_reasoning, @tokens_total, @source, @created_at
     )`,
  );
  const updateAttempt = db.prepare(
    `UPDATE plan_node_attempts
     SET ended_at = @ended_at, duration_ms = @duration_ms,
         tokens_input = @tokens_input, tokens_cached = @tokens_cached,
         tokens_output = @tokens_output, tokens_reasoning = @tokens_reasoning,
         tokens_total = @tokens_total
     WHERE id = @id`,
  );
  const selectAttemptsForPlan = db.prepare(
    "SELECT * FROM plan_node_attempts WHERE plan_id = ? ORDER BY created_at ASC",
  );
  const selectOpenAttemptByChild = db.prepare(
    "SELECT * FROM plan_node_attempts WHERE child_thread_id = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1",
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
  let currentRouting: RoleRouting = parseRoleRouting(
    await bb.storage.kv.get(ROUTING_KEY),
  );
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
      createdAt: row.created_at,
    };
  }

  function attemptDto(row: AttemptRow | undefined) {
    if (!row) return null;
    return {
      id: row.id,
      childThreadId: row.child_thread_id,
      providerId: row.provider_id,
      model: row.model,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      tokens: tokensFromAttempt(row),
      source: row.source,
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
    return {
      ...toMeta(row, nodes),
      nodes: await enrichNodes(row.id, nodes),
      harnessSnapshot: snapshot,
      totals: planTotals(row.id),
      skillWarnings: [] as string[],
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

  function planForThread(projectId: string, threadId: string): PlanRow | null {
    return (
      (selectPlansForThread.get(projectId, threadId) as PlanRow | undefined) ??
      null
    );
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
    const phase = existingArc && isPhase(existingArc.phase) ? existingArc.phase : "explore";
    const arc = existingArc
      ? { ...toArcDto(existingArc), phase }
      : {
          threadId: ownerId,
          projectId,
          phase,
          note: "",
          updatedAt: 0,
        };
    const planRow = existingArc ? planForThread(projectId, ownerId) : null;
    const plan = planRow ? await toFull(planRow) : null;
    const snapshot = planRow ? snapshotOf(planRow) : null;
    const harnessId = existingArc?.harness_id ?? snapshot?.id ?? null;
    const harnessDef = harnessId
      ? findHarness(harnessId, snapshot) ?? snapshot ?? null
      : null;
    const harness = existingArc ? (harnessDef ? toHarnessRef(harnessDef) : null) : null;
    const nextNode = plan ? nextWorkNode(plan.nodes) : null;
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

  async function stopChildThread(threadId: string, label: string): Promise<void> {
    try {
      await bb.sdk.threads.stop({ threadId });
      await closeAttemptForChild(threadId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot ${label}: failed to stop child ${threadId}. ${reason}`);
    }
  }

  async function stopLiveChildren(
    nodes: PlanNode[],
    label: string,
    predicate: (node: PlanNode) => boolean = () => true,
  ): Promise<PlanNode[]> {
    const live = nodes.filter(
      (node) =>
        (node.status === "in_progress" || node.status === "starting") &&
        node.childThreadId &&
        predicate(node),
    );
    for (const node of live) {
      await stopChildThread(node.childThreadId!, label);
    }
    return live;
  }

  async function closeAttemptForChild(childThreadId: string): Promise<void> {
    const open = selectOpenAttemptByChild.get(childThreadId) as AttemptRow | undefined;
    if (!open) return;
    const endedAt = Date.now();
    const tokens = (await readChildTokens(childThreadId)) ?? emptyTokenCounters();
    updateAttempt.run({
      id: open.id,
      ended_at: endedAt,
      duration_ms: durationMs(open.started_at, endedAt),
      tokens_input: tokens.input,
      tokens_cached: tokens.cached,
      tokens_output: tokens.output,
      tokens_reasoning: tokens.reasoning,
      tokens_total: tokens.total,
    });
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
        nodes: full.nodes.map((node) => ({
          id: node.id,
          phase: node.phase,
          status: node.status,
          result: node.result,
          artifacts: node.result?.artifactPaths ?? [],
        })),
        totals: full.totals,
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

  function recordOutcome(args: {
    planId: string;
    nodeId: string;
    verdict: CriticVerdict | null;
    summary: string | null;
    artifactPaths: string[];
    actor: string;
    source: string;
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
    parentThreadId?: string,
  ) {
    const plan = requirePlan(planId);
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

    if (!spawns) {
      publish();
      return { plan: await toFull(requirePlan(planId)) };
    }

    const parentId = plan.thread_id ?? parentThreadId;
    const recoverClaim = () => {
      recoverStartingNode.run(node.id, planId);
    };
    if (!parentId) {
      recoverClaim();
      throw new Error("Need a parent thread to spawn a child for this node's execution mode.");
    }

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
          created_at: now,
        });
        return true;
      })();
      if (!attached) {
        throw new Error("Node start claim was lost before the child could be attached.");
      }
    } catch (error) {
      recoverClaim();
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
  }): void {
    const planId = args.planId;
    const plan = requirePlan(planId);
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
  }

  async function stopInProgressCriticChildren(planId: string): Promise<PlanNode[]> {
    return stopLiveChildren(nodesOf(planId), "reopen Worker", (node) => node.phase === "critic");
  }

  async function reopenPlanNode(planId: string, nodeId: string): Promise<PlanNode> {
    const node = lookupPlanNode(planId, nodeId);
    if (node.phase !== "worker") {
      throw new Error("Only Worker nodes can be reopened after Critic.");
    }
    if (node.status !== "done") {
      throw new Error(`Node ${node.id} must be done before it can be reopened.`);
    }
    const critics = await stopInProgressCriticChildren(planId);
    persistWorkerReopen(planId, node.id, critics);
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

  async function reopenLastWorker(planId: string): Promise<void> {
    const workers = nodesOf(planId)
      .filter((node) => node.phase === "worker" && node.status === "done")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const last = workers[workers.length - 1];
    if (!last) return;
    await reopenPlanNode(planId, last.id);
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
    const node = lookupPlanNode(input.planId, input.nodeId);
    if (node.status !== "in_progress") {
      throw new Error(`Node ${node.id} must be in progress to mark done.`);
    }
    if (node.phase === "promote" && criticBlockedOf(plan)) {
      throw new Error("Promote is blocked until the operator resets the Critic BLOCK.");
    }
    const snapshot = snapshotOf(plan);
    const maxCorrections = snapshot?.maxCorrections ?? null;
    const artifactPaths = requireArtifactPaths(input.artifactPaths);
    const summary = input.summary?.trim() || null;

    if (node.phase === "critic") {
      const verdict = input.verdict;
      if (!verdict) {
        throw new Error("Critic completion requires verdict APPROVE, REWORK, or BLOCK.");
      }
      if (!summary) {
        throw new Error("Critic completion requires a short summary.");
      }
      if (verdict === "REWORK") {
        if (!canRework(correctionCountOf(plan), maxCorrections)) {
          throw new Error(
            `Correction limit reached (${correctionCountOf(plan)}/${maxCorrections}).`,
          );
        }
        const critics = await stopInProgressCriticChildren(input.planId);
        const workers = nodesOf(input.planId)
          .filter((item) => item.phase === "worker" && item.status === "done")
          .sort((a, b) => a.sortOrder - b.sortOrder);
        const lastWorker = workers[workers.length - 1];
        const commit = db.transaction(() => {
          recordOutcome({
            planId: input.planId,
            nodeId: node.id,
            verdict,
            summary,
            artifactPaths,
            actor: attribution.actor,
            source: attribution.source,
          });
          if (lastWorker) resetPlanNode.run("pending", lastWorker.id, input.planId);
          for (const critic of critics) {
            updateNodeStatus.run("pending", critic.id, input.planId);
          }
          const latest = requirePlan(input.planId);
          updatePlanFlags.run(correctionCountOf(latest) + 1, latest.critic_blocked, Date.now(), input.planId);
        });
        commit();
        if (plan.thread_id) await writeManifest(plan.thread_id, input.planId);
        publish();
        return lookupPlanNode(input.planId, node.id);
      }
      if (node.childThreadId) {
        await stopChildThread(node.childThreadId, "complete Critic");
      }
      const commit = db.transaction(() => {
        recordOutcome({
          planId: input.planId,
          nodeId: node.id,
          verdict,
          summary,
          artifactPaths,
          actor: attribution.actor,
          source: attribution.source,
        });
        updateNodeStatus.run("done", node.id, input.planId);
        const blocked = verdict === "BLOCK" ? 1 : 0;
        updatePlanFlags.run(correctionCountOf(plan), blocked, Date.now(), input.planId);
      });
      commit();
      if (plan.thread_id) await writeManifest(plan.thread_id, input.planId);
      publish();
      return lookupPlanNode(input.planId, node.id);
    }

    if (node.childThreadId) {
      await stopChildThread(node.childThreadId, "complete this node");
    }
    const commit = db.transaction(() => {
      recordOutcome({
        planId: input.planId,
        nodeId: node.id,
        verdict: null,
        summary,
        artifactPaths,
        actor: attribution.actor,
        source: attribution.source,
      });
      updateNodeStatus.run("done", node.id, input.planId);
      touchPlan.run(Date.now(), input.planId);
    });
    commit();
    if (plan.thread_id) await writeManifest(plan.thread_id, input.planId);
    publish();
    return lookupPlanNode(input.planId, node.id);
  }

  async function skipPlanNode(planId: string, nodeId: string): Promise<PlanNode> {
    const node = lookupPlanNode(planId, nodeId);
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
    publish();
    return lookupPlanNode(planId, node.id);
  }

  function resetCriticBlock(planId: string, attribution: { actor: string; source: string }): void {
    const plan = requirePlan(planId);
    const critic = nodesOf(planId)
      .filter((node) => node.phase === "critic")
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .at(-1);
    const commit = db.transaction(() => {
      updatePlanFlags.run(correctionCountOf(plan), 0, Date.now(), planId);
      if (critic) {
        recordOutcome({
          planId,
          nodeId: critic.id,
          verdict: null,
          summary: "Operator reset Critic BLOCK.",
          artifactPaths: [],
          actor: attribution.actor,
          source: attribution.source,
        });
      }
    });
    commit();
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
          "- Critic completes with APPROVE, REWORK, or BLOCK.",
          "- Pick a provider/model per role in plugin settings, or override it on a DAG node.",
          "- Keep auditable outputs in `artifacts/`.",
          "",
          "Commands: `bb harness status|advance|set-phase|start|plan …`",
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
  ): Promise<void> {
    const projectId = await resolveProjectId(input.threadId, input.projectId);
    await stopHistoricalRun(input.threadId);
    assertCanStart(input.threadId);
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
    };
    const insertAll = db.transaction(() => {
      insertArc.run({
        thread_id: input.threadId,
        project_id: projectId,
        phase: "explore",
        note: input.objective.trim(),
        updated_at: now,
        harness_id: frozen.id,
      });
      insertPlan.run(row);
      insertSeedNodes(row.id, frozen);
    });
    try {
      insertAll();
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


  async function startRun(input: z.infer<typeof startRunInputSchema>): Promise<void> {
    const harnessId = resolveHarnessId(input);
    const definition = requireHarness(harnessId);
    await startManualHarness(input, definition);
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

  async function stopRun(threadId: string, claimedProjectId?: string): Promise<void> {
    const projectId = await resolveProjectId(threadId, claimedProjectId);
    const arc = readArc(threadId);
    if (arc) {
      if (arc.project_id !== projectId) {
        throw new Error(`projectId ${arc.project_id} does not match thread ${threadId}.`);
      }
      const plan = planForThread(arc.project_id, threadId);
      if (plan) {
        const starting = nodesOf(plan.id).find((node) => node.status === "starting");
        if (starting) {
          throw new Error(
            `Cannot stop Harness while ${starting.id} is starting. Retry after the child is attached.`,
          );
        }
      }
    }
    const stoppedHistorical = await stopHistoricalRun(threadId);
    if (arc) {
      const plan = planForThread(arc.project_id, threadId);
      if (plan) {
        const live = nodesOf(plan.id);
        await stopLiveChildren(live, "stop Harness");
        const settle = db.transaction(() => {
          for (const node of nodesOf(plan.id)) {
            if (node.status === "in_progress") {
              updateNodeStatus.run("skipped", node.id, plan.id);
            }
          }
          deleteArc.run(threadId);
        });
        settle();
      } else {
        deleteArc.run(threadId);
      }
      publish();
      return;
    }
    if (stoppedHistorical) {
      publish();
      return;
    }
    throw new Error("No Harness run on this thread.");
  }

  async function reconcileFailedChild(threadId: string): Promise<void> {
    await closeAttemptForChild(threadId);
    // Re-read after telemetry close, then CAS. Done/skipped/stopped/new attempts stay.
    const row = selectNodeByChild.get(threadId) as NodeRow | undefined;
    if (!row) return;
    const changed = casFailedChild.run(row.id, row.plan_id, threadId);
    if (changed.changes === 1) publish();
  }

  bb.rpc.register(rpcContract, {
    getStatus: async ({ threadId, projectId }) =>
      statusPayload(threadId, await resolveProjectId(threadId, projectId)),
    setPhase: async ({ threadId, projectId, phase, note }) => {
      const resolved = await resolveProjectId(threadId, projectId);
      requireLegacyArc(threadId);
      writeArc(threadId, resolved, phase, note ?? "");
      return statusPayload(threadId, resolved);
    },
    advance: async ({ threadId, projectId }) => {
      const resolved = await resolveProjectId(threadId, projectId);
      const arc = requireLegacyArc(threadId);
      const phase = isPhase(arc.phase) ? arc.phase : "explore";
      const next = nextPhase(phase);
      if (!next) throw new Error("Already at Promote — the arc is complete.");
      writeArc(threadId, resolved, next);
      return statusPayload(threadId, resolved);
    },
    rewind: async ({ threadId, projectId }) => {
      const resolved = await resolveProjectId(threadId, projectId);
      const arc = requireLegacyArc(threadId);
      const phase = isPhase(arc.phase) ? arc.phase : "explore";
      const prev = previousPhase(phase);
      if (!prev) throw new Error("Already at Explore.");
      if (phase === "critic" && prev === "worker") {
        const plan = planForThread(resolved, threadId);
        if (plan) await reopenLastWorker(plan.id);
      }
      writeArc(threadId, resolved, prev);
      return statusPayload(threadId, resolved);
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
    addNode: async ({ planId, title, detail, phase, deps, projectId, threadId }) => {
      const plan = await requireParentPlan(planId, threadId, projectId, "mutate");
      addPlanNode({ planId, title, detail, phase, deps });
      publish();
      return { plan: await toFull(plan) };
    },
    startNode: async ({ planId, nodeId, threadId, projectId }) => {
      await requireParentPlan(planId, threadId, projectId, "mutate");
      return startPlanNode(planId, nodeId, threadId);
    },
    getRouting: () => ({ routing: currentRouting }),
    setRouting: async ({ slot, choice }) => {
      if (!isRoutingSlot(slot)) throw new Error(`Unknown routing slot ${slot}`);
      const next = { ...currentRouting, [slot]: choice };
      return { routing: await saveRouting(next) };
    },
    setNodeRouting: async ({ planId, nodeId, choice, projectId, threadId }) => {
      const plan = await requireParentPlan(planId, threadId, projectId, "mutate");
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
      publish();
      return { plan: await toFull(plan) };
    },
    suggestChoice: async () => ({ choice: await firstAvailableChoice() }),
    completeNode: async (input) => {
      const plan = await requireParentPlan(input.planId, input.threadId, input.projectId, "mutate");
      await completePlanNode(input, { actor: "operator", source: "rpc" });
      return { plan: await toFull(requirePlan(plan.id)) };
    },
    skipNode: async ({ planId, nodeId, projectId, threadId }) => {
      const plan = await requireParentPlan(planId, threadId, projectId, "mutate");
      await skipPlanNode(planId, nodeId);
      return { plan: await toFull(plan) };
    },
    reopenNode: async ({ planId, nodeId, projectId, threadId }) => {
      await requireParentPlan(planId, threadId, projectId, "mutate");
      await reopenPlanNode(planId, nodeId);
      return { plan: await toFull(requirePlan(planId)) };
    },
    resetCriticBlock: async ({ planId, projectId, threadId }) => {
      await requireParentPlan(planId, threadId, projectId, "mutate");
      resetCriticBlock(planId, { actor: "operator", source: "rpc" });
      return { plan: await toFull(requirePlan(planId)) };
    },
    initWorkspace: ({ threadId, projectId }) => initWorkspace(threadId, projectId),
    startRun: async (input) => {
      await startRun(input);
      return statusPayload(
        input.threadId,
        await resolveProjectId(input.threadId, input.projectId),
      );
    },
    stopRun: async ({ threadId, projectId }) => {
      await stopRun(threadId, projectId);
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
      if (arg === "--json" || arg === "--seed" || arg === "--no-seed" || arg === "--milestone") continue;
      if (
        arg === "--thread" ||
        arg === "--phase" ||
        arg === "--deps" ||
        arg === "--task" ||
        arg === "--node" ||
        arg === "--harness" ||
        arg === "--verdict" ||
        arg === "--summary" ||
        arg === "--artifacts"
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
    summary: "Drive the Explore → Plan → Worker → Critic → Promote harness arc",
    commands: [
      { name: "status", summary: "Show the current thread's arc and next DAG node", usage: "bb harness status [--thread <id>] [--json]" },
      { name: "advance", summary: "Move the arc one phase forward", usage: "bb harness advance [--thread <id>] [--json]" },
      { name: "rewind", summary: "Move the arc one phase back", usage: "bb harness rewind [--thread <id>] [--json]" },
      { name: "set-phase", summary: "Jump to a named phase", usage: "bb harness set-phase <phase> [--thread <id>] [--json]" },
      { name: "init", summary: "Scaffold artifacts/, plans/, and HARNESS.md in the workspace", usage: "bb harness init [--thread <id>] [--json]" },
      { name: "start", summary: "Start Standard Harness by default, or a named Harness", usage: "bb harness start --task <text> [--harness <id>] [--json]" },
      { name: "stop", summary: "Cancel the active Harness run", usage: "bb harness stop [--thread <id>] [--json]" },
      { name: "plan-list", summary: "List DAG plans for the current project", usage: "bb harness plan list [--json]" },
      { name: "plan-show", summary: "Show a DAG plan", usage: "bb harness plan show <plan-id> [--json]" },
      { name: "plan-create", summary: "Create a DAG plan (seeds the five-phase arc by default)", usage: "bb harness plan create <name> [--seed|--no-seed] [--json]" },
      { name: "plan-add", summary: "Add a node to a plan", usage: "bb harness plan add <plan-id> <title> [--phase worker] [--deps id,id] [--json]" },
      { name: "plan-next", summary: "Show the next unblocked node", usage: "bb harness plan next <plan-id> [--json]" },
      { name: "plan-start", summary: "Start a node (only one in progress at a time)", usage: "bb harness plan start <plan-id> <node-id> [--json]" },
      { name: "plan-complete", summary: "Mark a node done", usage: "bb harness plan complete <plan-id> <node-id> [--verdict APPROVE|REWORK|BLOCK] [--summary <text>] [--json]" },
    ],
    async run(argv, ctx) {
      const json = takeFlag(argv, "--json");
      const threadId = takeOption(argv, "--thread") ?? ctx.threadId;
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
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: `${usage()}\n` };
          case "status": {
            const missing = needThread();
            if (missing) return missing;
            const status = await statusPayload(
              threadId!,
              await resolveProjectId(threadId!, ctx.projectId),
            );
            return reply(status, formatStatus(status));
          }
          case "start": {
            const missing = needThread();
            if (missing) return missing;
            if (takeFlag(argv, "--milestone")) {
              return fail(removedHarnessError("milestone"));
            }
            const task = takeOption(argv, "--task") ?? rest.join(" ").trim();
            if (!task) return fail("start needs --task <text>");
            const harnessFlag = takeOption(argv, "--harness");
            await startRun({
              threadId: threadId!,
              projectId: ctx.projectId ?? undefined,
              objective: task,
              harnessId: harnessFlag,
            });
            const status = await statusPayload(
              threadId!,
              await resolveProjectId(threadId!, ctx.projectId),
            );
            return reply(status, formatStatus(status));
          }
          case "stop": {
            const missing = needThread();
            if (missing) return missing;
            await stopRun(threadId!, ctx.projectId);
            const status = await statusPayload(
              threadId!,
              await resolveProjectId(threadId!, ctx.projectId),
            );
            return reply(status, formatStatus(status));
          }
          case "advance": {
            const missing = needThread();
            if (missing) return missing;
            const projectId = await resolveProjectId(threadId!, ctx.projectId);
            const arc = requireLegacyArc(threadId!);
            const phase = isPhase(arc.phase) ? arc.phase : "explore";
            const next = nextPhase(phase);
            if (!next) return fail("Already at Promote — the arc is complete.");
            writeArc(threadId!, projectId, next);
            const status = await statusPayload(threadId!, projectId);
            return reply(status, formatStatus(status));
          }
          case "rewind": {
            const missing = needThread();
            if (missing) return missing;
            const projectId = await resolveProjectId(threadId!, ctx.projectId);
            const arc = requireLegacyArc(threadId!);
            const phase = isPhase(arc.phase) ? arc.phase : "explore";
            const prev = previousPhase(phase);
            if (!prev) return fail("Already at Explore.");
            if (phase === "critic" && prev === "worker") {
              const plan = planForThread(projectId, threadId!);
              if (plan) await reopenLastWorker(plan.id);
            }
            writeArc(threadId!, projectId, prev);
            const status = await statusPayload(threadId!, projectId);
            return reply(status, formatStatus(status));
          }
          case "set-phase": {
            const missing = needThread();
            if (missing) return missing;
            const phase = rest[0];
            if (!phase || !isPhase(phase)) {
              return fail("set-phase needs explore|plan|worker|critic|promote");
            }
            const projectId = await resolveProjectId(threadId!, ctx.projectId);
            requireLegacyArc(threadId!);
            writeArc(threadId!, projectId, phase);
            const status = await statusPayload(threadId!, projectId);
            return reply(status, formatStatus(status));
          }
          case "init": {
            const missing = needThread();
            if (missing) return missing;
            const result = await initWorkspace(threadId!, ctx.projectId);
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
          case "plan": {
            const sub = rest[0];
            const projectId = needProject();
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
                await requireParentPlan(id, threadId, ctx.projectId, "read");
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
                await requireParentPlan(planId, threadId, ctx.projectId, "mutate");
                addPlanNode({ planId, title, phase, deps });
                publish();
                const full = await toFull(requirePlan(planId));
                return reply(full, formatPlan(full));
              }
              case "reset-block": {
                const planId = rest[1];
                if (!planId) return fail("plan reset-block <plan-id>");
                await requireParentPlan(planId, threadId, ctx.projectId, "mutate");
                resetCriticBlock(planId, { actor: "operator", source: "cli" });
                const plan = await toFull(requirePlan(planId));
                return reply(plan, formatPlan(plan));
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
                await requireParentPlan(planId, threadId, ctx.projectId, "mutate");
                if (sub === "start") {
                  const started = await startPlanNode(planId, nodeId, threadId);
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
                  await completePlanNode(
                    {
                      planId,
                      nodeId,
                      threadId: threadId!,
                      verdict,
                      summary: takeOption(argv, "--summary"),
                      artifactPaths: artifacts.length ? artifacts : undefined,
                    },
                    { actor: "operator", source: "cli" },
                  );
                } else if (sub === "skip") await skipPlanNode(planId, nodeId);
                else await reopenPlanNode(planId, nodeId);
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
      "Advance this thread's harness arc by one phase, or jump to a named phase.",
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
    async execute({ threadId, phase }, ctx) {
      const id = threadId ?? ctx.threadId;
      if (!id) return "No thread id.";
      const projectId = await resolveProjectId(id, ctx.projectId ?? undefined);
      if (phase) {
        requireLegacyArc(id);
        writeArc(id, projectId, phase);
      } else {
        const arc = requireLegacyArc(id);
        const current = isPhase(arc.phase) ? arc.phase : "explore";
        const next = nextPhase(current);
        if (!next) return "Already at Promote.";
        writeArc(id, projectId, next);
      }
      return JSON.stringify(await statusPayload(id, projectId), null, 2);
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
        const started = await startPlanNode(planId, target.id, ctx.threadId);
        return JSON.stringify(
          { started: target, plan: started.plan },
          null,
          2,
        );
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
    parameters: completeNodeInputSchema.omit({ threadId: true }),
    async execute(input, ctx) {
      if (!ctx.threadId) {
        return "Invoke this tool from the parent thread that owns the plan.";
      }
      await requireParentPlan(input.planId, ctx.threadId, ctx.projectId, "mutate");
      const completed = await completePlanNode(
        { ...input, threadId: ctx.threadId },
        { actor: "parent-agent", source: "harness_complete_node" },
      );
      const plan = await toFull(requirePlan(input.planId));
      const next = nextWorkNode(plan.nodes);
      return JSON.stringify({ completed: completed.id, next, plan }, null, 2);
    },
  });

  function liveChildNode(threadId: string): PlanNode | null {
    const child = selectNodeByChild.get(threadId) as NodeRow | undefined;
    if (!child) return null;
    const node = toNode(child);
    if (node.status !== "in_progress" && node.status !== "starting") return null;
    const plan = selectPlan.get(child.plan_id) as PlanRow | undefined;
    if (!plan?.thread_id || !readArc(plan.thread_id)) return null;
    return node;
  }

  function parentExecutionInstructions(threadId: string): string | null {
    const owner = ownerThreadId(threadId);
    const arc = readArc(owner);
    if (!arc) return null;
    const phase = isPhase(arc.phase) ? arc.phase : "explore";
    const plan = planForThread(arc.project_id, owner);
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

  bb.agents.configure((context) => {
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
          "harness_advance",
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

  bb.agents.contributeInstructions(({ threadId, projectId }) => {
    if (!threadId || !projectId) return null;
    const child = liveChildNode(threadId);
    if (child) return nodePrompt(child, child.phase);
    return parentExecutionInstructions(threadId);
  });

  const refreshChild = ({ thread }: { thread: { id: string } }) => {
    const row = selectNodeByChild.get(thread.id) as NodeRow | undefined;
    if (row) publish();
  };
  bb.events.on("thread.idle", (payload) => {
    void closeAttemptForChild(payload.thread.id);
    refreshChild(payload);
  });
  bb.events.on("thread.active", refreshChild);
  bb.events.on("thread.failed", (payload) => {
    void reconcileFailedChild(payload.thread.id).then(() => refreshChild(payload));
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
