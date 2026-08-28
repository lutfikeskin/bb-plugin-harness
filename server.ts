// bb-plugin-harness — five-phase arc + DAG plans for BB threads.
//
// Explore → Plan → Worker → Critic → Promote. Worker/critic/promote spawn
// child threads. Role routing (provider + model) is stored in plugin KV.
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
  isRoutingSlot,
  isSpawnablePhase,
  nextPhase,
  nextWorkNode,
  nodeChoice,
  parseDeps,
  parseRoleRouting,
  previousPhase,
  recommendedTier,
  routingSlotFor,
  seedArcNodes,
  slugId,
  workerOrdinal,
  wouldCycle,
  type ExecutionChoice,
  type NodeStatus,
  type Phase,
  type PlanNode,
  type RoleRouting,
} from "./lib/harness";
import {
  CUSTOM_HARNESSES_KEY,
  STANDARD_HARNESS_ID,
  applyHarnessPatch,
  builtinHarnesses,
  cloneStandardHarness,
  isReservedHarnessId,
  parseCustomHarnesses,
  parseHarnessDefinition,
  resolveHarnessId,
  snapshotHarness,
  standardHarnessDefinition,
  toHarnessRef,
  type HarnessDefinition,
} from "./lib/definitions";
import {
  AGENT_ROLES,
  LIVE_RUN_STATUSES,
  MILESTONE_PIPELINE_ID,
  PACKET_KINDS,
  PROMPT_VERSION,
  REVIEW_VERDICTS,
  ROLE_PACKET_KIND,
  ROLE_TITLE,
  RUN_NODE_STATUSES,
  RUN_STATUSES,
  SCHEMA_VERSION,
  activeRunNode,
  applyNodeRouting,
  buildRolePrompt,
  canApproveCorrection,
  canApprovePlan,
  canRetryNode,
  canStopRun,
  correctionNodes,
  firstReadyNode,
  intentAfterPacket,
  nodeOverrideChoice,
  isLiveRunStatus,
  isTerminalRunStatus,
  milestonePipelineNodes,
  parseTaskPacket,
  participantInstruction,
  priorPacketsForRole,
  routingSlotForRunNode,
  validateRolePacket,
  type AgentRole,
  type HarnessRun,
  type HarnessRunNode,
  type PacketKind,
  type RunNodeStatus,
  type RunStatus,
  type TaskPacket,
} from "./lib/run-engine";

const REALTIME_CHANNEL = "harness";

const phaseSchema = z.enum(PHASES);
const nodeStatusSchema = z.enum(["pending", "in_progress", "done", "skipped"]);

const arcSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  phase: phaseSchema,
  note: z.string(),
  updatedAt: z.number(),
});

const reasoningLevelSchema = z.enum(REASONING_LEVELS);
const executionChoiceSchema = z.object({
  providerId: z.string(),
  model: z.string(),
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
  child: childThreadSchema.nullable(),
});

const phaseSpecSchema = z.object({
  title: z.string(),
  detail: z.string(),
});
const harnessDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(["builtin", "custom"]),
  engine: z.enum(["manual", "milestone"]),
  phases: z.object({
    explore: phaseSpecSchema,
    plan: phaseSpecSchema,
    worker: phaseSpecSchema,
    critic: phaseSpecSchema,
    promote: phaseSpecSchema,
  }),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const harnessRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(["builtin", "custom"]),
  engine: z.enum(["manual", "milestone"]),
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
});

const planFullSchema = planMetaSchema.extend({
  nodes: z.array(planNodeSchema),
  harnessSnapshot: harnessDefinitionSchema.nullable(),
});

export type ArcDto = z.infer<typeof arcSchema>;
export type PlanNodeDto = z.infer<typeof planNodeSchema>;
export type PlanMetaDto = z.infer<typeof planMetaSchema>;
export type PlanFullDto = z.infer<typeof planFullSchema>;
export type HarnessStatusDto = z.infer<typeof statusSchema>;

const runNodeSchema = z.object({
  id: z.string(),
  runId: z.string(),
  templateNodeKey: z.string(),
  role: z.enum(AGENT_ROLES),
  phase: phaseSchema,
  ordinal: z.number(),
  status: z.enum(RUN_NODE_STATUSES),
  deps: z.array(z.string()),
  childThreadId: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  serviceTier: z.string().nullable(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  packetVersion: z.number(),
  child: childThreadSchema.nullable(),
});

const packetSchema = z.object({
  id: z.string(),
  runId: z.string(),
  runNodeId: z.string(),
  kind: z.enum(PACKET_KINDS),
  version: z.number(),
  payload: z.unknown(),
  createdAt: z.number(),
});

const taskPacketSchema = z.object({
  objective: z.string(),
  branch: z.string().nullable(),
  execPlanPath: z.string().nullable(),
  protectedPaths: z.array(z.string()),
  runScout: z.boolean(),
  specialistQuestion: z.string().nullable(),
  routingOverrides: roleRoutingSchema.nullable(),
  projectId: z.string(),
  parentThreadId: z.string(),
  environmentId: z.string().nullable(),
  promptVersion: z.string(),
  schemaVersion: z.string(),
});

const runDetailsSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  parentThreadId: z.string(),
  templateId: z.string(),
  status: z.enum(RUN_STATUSES),
  currentStageId: z.string().nullable(),
  taskPacket: taskPacketSchema,
  correctionCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
  nodes: z.array(runNodeSchema),
  packets: z.array(packetSchema),
  currentNode: runNodeSchema.nullable(),
  controls: z.object({
    canApprovePlan: z.boolean(),
    canApproveCorrection: z.boolean(),
    canStop: z.boolean(),
    canRetry: z.boolean(),
  }),
});

const statusSchema = z.object({
  arc: arcSchema,
  plan: planFullSchema.nullable(),
  nextNode: planNodeSchema.nullable(),
  tier: z.enum(["frontier", "commodity"]),
  commodityModel: z.string(),
  frontierModel: z.string(),
  prewalkEnabled: z.boolean(),
  routing: roleRoutingSchema,
  run: runDetailsSchema.nullable(),
  harness: harnessRefSchema.nullable(),
  customHarnesses: z.array(harnessDefinitionSchema),
});

const startRunInputSchema = z.object({
  threadId: z.string(),
  projectId: z.string().optional(),
  objective: z.string().trim().min(1).max(8000),
  branch: z.string().trim().max(200).optional(),
  execPlanPath: z.string().trim().max(500).optional(),
  protectedPaths: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  runScout: z.boolean().optional(),
  specialistQuestion: z.string().trim().max(4000).optional(),
  harnessId: z.string().trim().min(1).max(64).optional(),
  templateId: z.string().trim().min(1).max(64).optional(),
  routingOverrides: roleRoutingSchema.optional(),
  nodeRouting: z.record(z.string(), executionChoiceSchema).optional(),
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
    input: z.object({ id: z.string() }),
    output: z.object({ plan: planFullSchema.nullable() }),
  },
  createPlan: {
    input: z.object({
      projectId: z.string(),
      threadId: z.string().nullable().optional(),
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
    }),
    output: z.object({ plan: planFullSchema }),
  },
  startNode: {
    input: z.object({
      planId: z.string(),
      nodeId: z.string(),
      threadId: z.string().optional(),
    }),
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
    }),
    output: z.object({ plan: planFullSchema }),
  },
  setRunNodeRouting: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
      nodeId: z.string(),
      choice: executionChoiceSchema.nullable(),
    }),
    output: statusSchema,
  },
  suggestChoice: {
    input: z.object({}),
    output: z.object({ choice: executionChoiceSchema }),
  },
  completeNode: {
    input: z.object({ planId: z.string(), nodeId: z.string() }),
    output: z.object({ plan: planFullSchema }),
  },
  skipNode: {
    input: z.object({ planId: z.string(), nodeId: z.string() }),
    output: z.object({ plan: planFullSchema }),
  },
  initWorkspace: {
    input: z.object({ threadId: z.string() }),
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
  approvePlan: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
    }),
    output: statusSchema,
  },
  approveCorrection: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
    }),
    output: statusSchema,
  },
  retryStage: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
      nodeId: z.string().optional(),
    }),
    output: statusSchema,
  },
  getRun: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
      runId: z.string().optional(),
    }),
    output: z.object({ run: runDetailsSchema.nullable() }),
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
};

type RunRow = {
  id: string;
  project_id: string;
  parent_thread_id: string;
  template_id: string;
  status: string;
  current_stage_id: string | null;
  task_packet_json: string;
  correction_count: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type RunNodeRow = {
  id: string;
  run_id: string;
  template_node_key: string;
  role: string;
  phase: string;
  ordinal: number;
  status: string;
  deps: string;
  child_thread_id: string | null;
  provider_id: string | null;
  model: string | null;
  reasoning_level: string | null;
  service_tier: string | null;
  started_at: number | null;
  completed_at: number | null;
  packet_version: number;
};

type PacketRow = {
  id: string;
  run_id: string;
  run_node_id: string;
  kind: string;
  version: number;
  payload_json: string;
  created_at: number;
};

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function toNode(row: NodeRow): PlanNode {
  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    phase: isPhase(row.phase) ? row.phase : "worker",
    status: row.status as NodeStatus,
    deps: parseDeps(row.deps),
    sortOrder: row.sort_order,
    childThreadId: row.child_thread_id ?? null,
    providerId: row.provider_id ?? null,
    model: row.model ?? null,
    reasoningLevel: row.reasoning_level ?? null,
    serviceTier: row.service_tier ?? null,
  };
}

function usage(): string {
  return [
    "Usage:",
    "  bb harness status [--thread <id>] [--json]",
    "  bb harness advance [--thread <id>] [--json]",
    "  bb harness rewind [--thread <id>] [--json]",
    "  bb harness set-phase <explore|plan|worker|critic|promote> [--thread <id>] [--json]",
    "  bb harness start --task <text> [--harness <id>] [--milestone] [--no-scout] [--exec-plan <path>] [--branch <name>] [--protected a,b] [--specialist <q>] [--thread <id>] [--json]",
    "  bb harness stop [--thread <id>] [--json]",
    "  bb harness approve-plan [--thread <id>] [--json]",
    "  bb harness approve-correction [--thread <id>] [--json]",
    "  bb harness retry [--node <id>] [--thread <id>] [--json]",
    "  bb harness plan list [--json]",
    "  bb harness plan show <plan-id> [--json]",
    "  bb harness plan create <name> [--seed] [--no-seed] [--thread <id>] [--json]",
    "  bb harness plan add <plan-id> <title> [--phase <phase>] [--deps id,id] [--json]",
    "  bb harness plan next <plan-id> [--json]",
    "  bb harness plan start <plan-id> <node-id> [--json]",
    "  bb harness plan complete <plan-id> <node-id> [--json]",
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
    `INSERT INTO plans (id, project_id, thread_id, name, created_at, updated_at, harness_id, harness_snapshot)
     VALUES (@id, @project_id, @thread_id, @name, @created_at, @updated_at, @harness_id, @harness_snapshot)`,
  );
  const touchPlan = db.prepare(
    "UPDATE plans SET updated_at = ? WHERE id = ?",
  );
  const updatePlanSnapshot = db.prepare(
    "UPDATE plans SET harness_id = ?, harness_snapshot = ?, updated_at = ? WHERE id = ?",
  );
  const selectNodes = db.prepare(
    "SELECT * FROM plan_nodes WHERE plan_id = ? ORDER BY sort_order ASC",
  );
  const insertNode = db.prepare(
    `INSERT INTO plan_nodes (id, plan_id, title, detail, phase, status, deps, sort_order)
     VALUES (@id, @plan_id, @title, @detail, @phase, @status, @deps, @sort_order)`,
  );
  const updateNodeStatus = db.prepare(
    "UPDATE plan_nodes SET status = ? WHERE id = ? AND plan_id = ?",
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

  const selectRun = db.prepare("SELECT * FROM harness_runs WHERE id = ?");
  const selectLiveRun = db.prepare(
    `SELECT * FROM harness_runs
     WHERE parent_thread_id = ?
       AND status IN ('configuring','running','awaiting_plan_approval','awaiting_correction_approval')
     ORDER BY created_at DESC LIMIT 1`,
  );
  const selectLatestRun = db.prepare(
    `SELECT * FROM harness_runs WHERE parent_thread_id = ? ORDER BY created_at DESC LIMIT 1`,
  );
  const insertRun = db.prepare(
    `INSERT INTO harness_runs (
       id, project_id, parent_thread_id, template_id, status, current_stage_id,
       task_packet_json, correction_count, created_at, updated_at, completed_at
     ) VALUES (
       @id, @project_id, @parent_thread_id, @template_id, @status, @current_stage_id,
       @task_packet_json, @correction_count, @created_at, @updated_at, @completed_at
     )`,
  );
  const updateRunRow = db.prepare(
    `UPDATE harness_runs
     SET status = @status, current_stage_id = @current_stage_id,
         correction_count = @correction_count, updated_at = @updated_at,
         completed_at = @completed_at
     WHERE id = @id`,
  );
  const selectRunNodes = db.prepare(
    "SELECT * FROM harness_run_nodes WHERE run_id = ? ORDER BY ordinal ASC",
  );
  const selectRunNode = db.prepare("SELECT * FROM harness_run_nodes WHERE id = ?");
  const selectRunNodeByChild = db.prepare(
    "SELECT * FROM harness_run_nodes WHERE child_thread_id = ?",
  );
  const insertRunNode = db.prepare(
    `INSERT INTO harness_run_nodes (
       id, run_id, template_node_key, role, phase, ordinal, status, deps,
       child_thread_id, provider_id, model, reasoning_level, service_tier,
       started_at, completed_at, packet_version
     ) VALUES (
       @id, @run_id, @template_node_key, @role, @phase, @ordinal, @status, @deps,
       @child_thread_id, @provider_id, @model, @reasoning_level, @service_tier,
       @started_at, @completed_at, @packet_version
     )`,
  );
  const updateRunNodeRow = db.prepare(
    `UPDATE harness_run_nodes
     SET status = @status, child_thread_id = @child_thread_id,
         started_at = @started_at, completed_at = @completed_at,
         packet_version = @packet_version, deps = @deps,
         provider_id = @provider_id, model = @model,
         reasoning_level = @reasoning_level, service_tier = @service_tier
     WHERE id = @id`,
  );
  const selectPackets = db.prepare(
    "SELECT * FROM harness_packets WHERE run_id = ? ORDER BY created_at ASC",
  );
  const selectPacketForNodeVersion = db.prepare(
    "SELECT * FROM harness_packets WHERE run_node_id = ? AND version = ?",
  );
  const insertPacket = db.prepare(
    `INSERT INTO harness_packets (id, run_id, run_node_id, kind, version, payload_json, created_at)
     VALUES (@id, @run_id, @run_node_id, @kind, @version, @payload_json, @created_at)`,
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
    customHarnesses = next;
    await bb.storage.kv.set(CUSTOM_HARNESSES_KEY, next);
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
    const found = findHarness(id);
    if (!found) throw new Error(`Unknown Harness ${id}.`);
    return found;
  }

  function publish(): void {
    bb.realtime.publish(REALTIME_CHANNEL, { at: Date.now() });
  }

  function toRunNode(row: RunNodeRow): HarnessRunNode {
    return {
      id: row.id,
      runId: row.run_id,
      templateNodeKey: row.template_node_key,
      role: row.role as AgentRole,
      phase: isPhase(row.phase) ? row.phase : "worker",
      ordinal: row.ordinal,
      status: row.status as RunNodeStatus,
      deps: parseDeps(row.deps),
      childThreadId: row.child_thread_id,
      providerId: row.provider_id,
      model: row.model,
      reasoningLevel: row.reasoning_level,
      serviceTier: row.service_tier,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      packetVersion: row.packet_version,
    };
  }

  function toRun(row: RunRow): HarnessRun {
    const packet = parseTaskPacket(JSON.parse(row.task_packet_json));
    if (!packet) {
      throw new Error(`Run ${row.id} has an invalid task packet`);
    }
    return {
      id: row.id,
      projectId: row.project_id,
      parentThreadId: row.parent_thread_id,
      templateId: row.template_id,
      status: row.status as RunStatus,
      currentStageId: row.current_stage_id,
      taskPacket: packet,
      correctionCount: row.correction_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  function runNodesOf(runId: string): HarnessRunNode[] {
    return (selectRunNodes.all(runId) as RunNodeRow[]).map(toRunNode);
  }

  function persistRun(run: HarnessRun): void {
    updateRunRow.run({
      id: run.id,
      status: run.status,
      current_stage_id: run.currentStageId,
      correction_count: run.correctionCount,
      updated_at: Date.now(),
      completed_at: run.completedAt,
    });
  }

  function persistRunNode(node: HarnessRunNode): void {
    updateRunNodeRow.run({
      id: node.id,
      status: node.status,
      child_thread_id: node.childThreadId,
      started_at: node.startedAt,
      completed_at: node.completedAt,
      packet_version: node.packetVersion,
      deps: JSON.stringify(node.deps),
      provider_id: node.providerId,
      model: node.model,
      reasoning_level: node.reasoningLevel,
      service_tier: node.serviceTier,
    });
  }

  function liveRunFor(threadId: string): HarnessRun | null {
    const byChild = selectRunNodeByChild.get(threadId) as RunNodeRow | undefined;
    if (byChild) {
      const row = selectRun.get(byChild.run_id) as RunRow | undefined;
      return row && isLiveRunStatus(row.status) ? toRun(row) : null;
    }
    const row = selectLiveRun.get(threadId) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  function latestRunFor(threadId: string): HarnessRun | null {
    const byChild = selectRunNodeByChild.get(threadId) as RunNodeRow | undefined;
    if (byChild) {
      const row = selectRun.get(byChild.run_id) as RunRow | undefined;
      return row ? toRun(row) : null;
    }
    const row = selectLatestRun.get(threadId) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  function requireLiveRun(threadId: string): HarnessRun {
    const run = liveRunFor(threadId);
    if (!run || !isLiveRunStatus(run.status)) {
      throw new Error("No active Harness run. Start one with bb harness start.");
    }
    return run;
  }

  function phaseFromRun(run: HarnessRun, nodes = runNodesOf(run.id)): Phase {
    const current = nodes.find((node) => node.id === run.currentStageId) ?? activeRunNode(nodes);
    if (current) return current.phase;
    const last = [...nodes].reverse().find((node) => node.status === "done" || node.status === "skipped");
    return last?.phase ?? "explore";
  }

  function resolvedRunChoice(nodes: HarnessRunNode[], node: HarnessRunNode, packet: TaskPacket): ExecutionChoice | null {
    const override = nodeOverrideChoice(node);
    if (override) return override;
    const slot = routingSlotForRunNode(nodes, node);
    if (packet.routingOverrides) return packet.routingOverrides[slot];
    return currentRouting[slot];
  }

  async function enrichRunNodes(nodes: HarnessRunNode[]) {
    return Promise.all(
      nodes.map(async (node) => {
        const base = {
          id: node.id,
          runId: node.runId,
          templateNodeKey: node.templateNodeKey,
          role: node.role,
          phase: node.phase,
          ordinal: node.ordinal,
          status: node.status,
          deps: node.deps,
          childThreadId: node.childThreadId,
          providerId: node.providerId,
          model: node.model,
          reasoningLevel: node.reasoningLevel,
          serviceTier: node.serviceTier,
          startedAt: node.startedAt,
          completedAt: node.completedAt,
          packetVersion: node.packetVersion,
          child: null as z.infer<typeof childThreadSchema> | null,
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

  async function toRunDetails(run: HarnessRun) {
    const nodes = runNodesOf(run.id);
    const packets = (selectPackets.all(run.id) as PacketRow[]).map((row) => ({
      id: row.id,
      runId: row.run_id,
      runNodeId: row.run_node_id,
      kind: row.kind as PacketKind,
      version: row.version,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }));
    const enriched = await enrichRunNodes(nodes);
    const currentId = run.currentStageId ?? activeRunNode(nodes)?.id ?? null;
    const failed = nodes.some((node) => node.status === "failed");
    return {
      id: run.id,
      projectId: run.projectId,
      parentThreadId: run.parentThreadId,
      templateId: run.templateId,
      status: run.status,
      currentStageId: run.currentStageId,
      taskPacket: run.taskPacket,
      correctionCount: run.correctionCount,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      nodes: enriched,
      packets,
      currentNode: enriched.find((node) => node.id === currentId) ?? null,
      controls: {
        canApprovePlan: canApprovePlan(run),
        canApproveCorrection: canApproveCorrection(run),
        canStop: canStopRun(run),
        canRetry: isLiveRunStatus(run.status) && failed,
      },
    };
  }

  function packetHistory(runId: string) {
    const nodes = runNodesOf(runId);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return (selectPackets.all(runId) as PacketRow[]).map((row) => {
      const node = byId.get(row.run_node_id);
      return {
        kind: row.kind as PacketKind,
        role: (node?.role ?? "worker") as AgentRole,
        payload: JSON.parse(row.payload_json) as unknown,
        templateNodeKey: node?.templateNodeKey ?? "",
      };
    });
  }

  async function spawnRunNode(run: HarnessRun, node: HarnessRunNode): Promise<void> {
    if (activeRunNode(runNodesOf(run.id)) && activeRunNode(runNodesOf(run.id))?.id !== node.id) {
      throw new Error("Only one Harness node may be active at a time.");
    }
    const now = Date.now();
    node.status = "starting";
    node.startedAt = now;
    persistRunNode(node);
    run.status = "running";
    run.currentStageId = node.id;
    persistRun(run);

    const parent = await bb.sdk.threads.get({ threadId: run.parentThreadId });
    const environmentId = run.taskPacket.environmentId;
    if (!environmentId) {
      node.status = "failed";
      persistRunNode(node);
      throw new Error("This Harness run has no frozen environment; cannot spawn a child.");
    }
    const nodes = runNodesOf(run.id);
    const choice = resolvedRunChoice(nodes, node, run.taskPacket);
    if (choice) {
      applyNodeRouting(node, choice);
      persistRunNode(node);
    }
    const prior = priorPacketsForRole(node.role, packetHistory(run.id));
    const prompt = buildRolePrompt({
      role: node.role,
      node,
      taskPacket: run.taskPacket,
      priorPackets: prior,
    });
    const title = `${ROLE_TITLE[node.role]}: ${node.templateNodeKey}`.slice(0, 80);
    try {
      const child = await bb.sdk.threads.spawn({
        prompt,
        parentThreadId: parent.id,
        projectId: parent.projectId,
        title,
        visibility: "visible",
        origin: "plugin",
        environment: { type: "reuse", environmentId },
        ...(choice
          ? {
              providerId: choice.providerId,
              model: choice.model,
              reasoningLevel: choice.reasoningLevel,
              ...(choice.serviceTier ? { serviceTier: choice.serviceTier } : {}),
              executionInputSources: {
                providerId: "explicit" as const,
                model: "explicit" as const,
                reasoningLevel: "explicit" as const,
                ...(choice.serviceTier ? { serviceTier: "explicit" as const } : {}),
              },
            }
          : {}),
      });
      node.childThreadId = child.id;
      node.status = "in_progress";
      persistRunNode(node);
    } catch (error) {
      node.status = "failed";
      persistRunNode(node);
      throw error;
    }
    publish();
  }

  async function startReadyNode(run: HarnessRun): Promise<void> {
    const next = firstReadyNode(runNodesOf(run.id));
    if (!next) return;
    await spawnRunNode(run, next);
  }

  function applyIntent(
    run: HarnessRun,
    nodes: HarnessRunNode[],
    intent: ReturnType<typeof intentAfterPacket>,
  ): { startKey: string | null } {
    if (intent.type === "await_plan_approval") {
      run.status = "awaiting_plan_approval";
      persistRun(run);
      return { startKey: null };
    }
    if (intent.type === "await_correction_approval") {
      run.status = "awaiting_correction_approval";
      persistRun(run);
      return { startKey: null };
    }
    if (intent.type === "complete") {
      run.status = "completed";
      run.completedAt = Date.now();
      persistRun(run);
      return { startKey: null };
    }
    if (intent.type === "blocked") {
      run.status = "blocked";
      run.completedAt = Date.now();
      persistRun(run);
      return { startKey: null };
    }
    if (intent.type === "start_node") {
      return { startKey: intent.templateNodeKey };
    }
    persistRun(run);
    return { startKey: null };
  }

  async function startRun(input: z.infer<typeof startRunInputSchema>): Promise<void> {
    const harnessId = resolveHarnessId(input);
    const definition = requireHarness(harnessId);
    if (definition.engine === "milestone") {
      await startMilestoneRun(input);
      return;
    }
    await startManualHarness(input, definition);
  }

  function assertCanStart(threadId: string): void {
    if (selectLiveRun.get(threadId) || readArc(threadId)) {
      throw new Error("A Harness run is already active on this thread.");
    }
  }

  async function startManualHarness(
    input: z.infer<typeof startRunInputSchema>,
    definition: HarnessDefinition,
  ): Promise<void> {
    const parent = await bb.sdk.threads.get({ threadId: input.threadId });
    const projectId = input.projectId ?? parent.projectId;
    assertCanStart(input.threadId);
    const now = Date.now();
    const frozen = snapshotHarness(definition);
    const row: PlanRow = {
      id: shortId(),
      project_id: projectId,
      thread_id: input.threadId,
      name: input.objective.trim().slice(0, 200),
      created_at: now,
      updated_at: now,
      harness_id: frozen.id,
      harness_snapshot: JSON.stringify(frozen),
    };
    const insertAll = db.transaction(() => {
      insertPlan.run(row);
      insertSeedNodes(row.id, frozen);
      upsertArc.run({
        thread_id: input.threadId,
        project_id: projectId,
        phase: "explore",
        note: input.objective.trim(),
        updated_at: now,
        harness_id: frozen.id,
      });
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
    publish();
  }

  async function startMilestoneRun(input: z.infer<typeof startRunInputSchema>): Promise<void> {
    const parent = await bb.sdk.threads.get({ threadId: input.threadId });
    const projectId = input.projectId ?? parent.projectId;
    assertCanStart(input.threadId);
    if (!parent.environmentId) {
      throw new Error("Parent thread has no environment; cannot start a Harness run.");
    }
    const now = Date.now();
    const taskPacket: TaskPacket = {
      objective: input.objective.trim(),
      branch: input.branch?.trim() || null,
      execPlanPath: input.execPlanPath?.trim() || null,
      protectedPaths: input.protectedPaths ?? [],
      runScout: input.runScout !== false,
      specialistQuestion: input.specialistQuestion?.trim() || null,
      routingOverrides: input.routingOverrides ?? { ...currentRouting },
      projectId,
      parentThreadId: input.threadId,
      environmentId: parent.environmentId,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
    };
    const runId = randomUUID();
    const templates = milestonePipelineNodes({
      runScout: taskPacket.runScout,
      specialistQuestion: taskPacket.specialistQuestion,
    });
    const insertAll = db.transaction(() => {
      insertRun.run({
        id: runId,
        project_id: projectId,
        parent_thread_id: input.threadId,
        template_id: MILESTONE_PIPELINE_ID,
        status: "running",
        current_stage_id: null,
        task_packet_json: JSON.stringify(taskPacket),
        correction_count: 0,
        created_at: now,
        updated_at: now,
        completed_at: null,
      });
      for (const [index, template] of templates.entries()) {
        insertRunNode.run({
          id: randomUUID(),
          run_id: runId,
          template_node_key: template.key,
          role: template.role,
          phase: template.phase,
          ordinal: index,
          status: template.skip ? "skipped" : "pending",
          deps: JSON.stringify(template.deps),
          child_thread_id: null,
          provider_id: null,
          model: null,
          reasoning_level: null,
          service_tier: null,
          started_at: null,
          completed_at: template.skip ? now : null,
          packet_version: 1,
        });
      }
    });
    try {
      insertAll();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("harness_runs_one_live") || message.includes("UNIQUE")) {
        throw new Error("A Harness run is already active on this thread.");
      }
      throw error;
    }
    const run = toRun(selectRun.get(runId) as RunRow);
    if (input.nodeRouting) {
      for (const node of runNodesOf(run.id)) {
        const choice = input.nodeRouting[node.templateNodeKey];
        if (!choice) continue;
        applyNodeRouting(node, choice);
        persistRunNode(node);
      }
    }
    try {
      await startReadyNode(run);
    } catch (error) {
      publish();
      throw error;
    }
    publish();
  }

  async function stopRun(threadId: string): Promise<void> {
    const run = latestRunFor(threadId);
    if (run && !isTerminalRunStatus(run.status)) {
      run.status = "cancelled";
      run.completedAt = Date.now();
      persistRun(run);
      for (const node of runNodesOf(run.id)) {
        if (node.status === "in_progress" || node.status === "starting") {
          node.status = "failed";
          node.completedAt = Date.now();
          persistRunNode(node);
          if (node.childThreadId) {
            try {
              await bb.sdk.threads.stop({ threadId: node.childThreadId });
            } catch {
              // Child stop is best-effort; the run is already terminal.
            }
          }
        }
      }
      publish();
      return;
    }
    if (readArc(threadId)) {
      deleteArc.run(threadId);
      publish();
      return;
    }
    if (run && isTerminalRunStatus(run.status)) return;
    throw new Error("No Harness run on this thread.");
  }

  async function approvePlan(threadId: string): Promise<void> {
    const run = requireLiveRun(threadId);
    if (!canApprovePlan(run)) {
      throw new Error("This run is not awaiting plan approval.");
    }
    run.status = "running";
    persistRun(run);
    await startReadyNode(run);
    publish();
  }

  async function approveCorrection(threadId: string): Promise<void> {
    const run = requireLiveRun(threadId);
    if (!canApproveCorrection(run)) {
      throw new Error("This run cannot start a correction pass.");
    }
    const existing = runNodesOf(run.id);
    if (existing.some((node) => node.templateNodeKey === "worker_correction")) {
      throw new Error("A correction pass already exists on this run.");
    }
    const now = Date.now();
    const extras = correctionNodes();
    const startOrdinal = existing.length;
    db.transaction(() => {
      for (const [index, template] of extras.entries()) {
        insertRunNode.run({
          id: randomUUID(),
          run_id: run.id,
          template_node_key: template.key,
          role: template.role,
          phase: template.phase,
          ordinal: startOrdinal + index,
          status: "pending",
          deps: JSON.stringify(template.deps),
          child_thread_id: null,
          provider_id: null,
          model: null,
          reasoning_level: null,
          service_tier: null,
          started_at: null,
          completed_at: null,
          packet_version: 1,
        });
      }
      const promote = existing.find((node) => node.templateNodeKey === "promote");
      if (promote) {
        promote.deps = ["reviewer_final"];
        persistRunNode(promote);
      }
      run.correctionCount = 1;
      run.status = "running";
      persistRun(run);
    })();
    await startReadyNode(toRun(selectRun.get(run.id) as RunRow));
    publish();
  }

  async function retryStage(threadId: string, nodeId?: string): Promise<void> {
    const run = requireLiveRun(threadId);
    const nodes = runNodesOf(run.id);
    const node = nodeId
      ? nodes.find((candidate) => candidate.id === nodeId)
      : nodes.find((candidate) => candidate.status === "failed");
    if (!node) throw new Error("No failed stage to retry.");
    if (!canRetryNode(run, node)) {
      throw new Error(`Node ${node.templateNodeKey} cannot be retried.`);
    }
    node.status = "pending";
    node.childThreadId = null;
    node.startedAt = null;
    node.completedAt = null;
    node.packetVersion += 1;
    persistRunNode(node);
    run.status = "running";
    persistRun(run);
    await spawnRunNode(run, node);
    publish();
  }

  function setRunNodeRouting(threadId: string, nodeId: string, choice: ExecutionChoice | null): void {
    const run = requireLiveRun(threadId);
    const node = runNodesOf(run.id).find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`No run node ${nodeId}.`);
    if (node.status !== "pending" && node.status !== "failed") {
      throw new Error(`Node ${node.templateNodeKey} can only override routing while pending or failed.`);
    }
    applyNodeRouting(node, choice);
    persistRunNode(node);
    publish();
  }

  function failActiveChildWithoutPacket(childThreadId: string): void {
    const row = selectRunNodeByChild.get(childThreadId) as RunNodeRow | undefined;
    if (!row) return;
    const runRow = selectRun.get(row.run_id) as RunRow | undefined;
    if (!runRow || !isLiveRunStatus(runRow.status)) return;
    const node = toRunNode(row);
    if (node.status !== "in_progress" && node.status !== "starting") return;
    if (selectPacketForNodeVersion.get(node.id, node.packetVersion)) return;
    node.status = "failed";
    node.completedAt = Date.now();
    persistRunNode(node);
    const run = toRun(runRow);
    run.currentStageId = node.id;
    persistRun(run);
  }

  async function submitRunPacket(args: {
    threadId: string;
    role: string;
    kind: string;
    payload: unknown;
  }): Promise<string> {
    const row = selectRunNodeByChild.get(args.threadId) as RunNodeRow | undefined;
    if (!row) {
      throw new Error("This thread is not a Harness role child.");
    }
    const run = toRun(selectRun.get(row.run_id) as RunRow);
    if (!isLiveRunStatus(run.status) && run.status !== "awaiting_plan_approval") {
      throw new Error("This Harness run is not accepting packets.");
    }
    const node = toRunNode(row);
    if (node.status !== "in_progress") {
      throw new Error(`Node ${node.templateNodeKey} is ${node.status} and cannot submit.`);
    }
    if (args.role !== node.role) {
      throw new Error(`Role mismatch: node is ${node.role}, submission is ${args.role}`);
    }
    const validated = validateRolePacket(node.role, args.kind, args.payload);
    if (!validated.ok) throw new Error(validated.error);
    if (selectPacketForNodeVersion.get(node.id, node.packetVersion)) {
      throw new Error("A packet was already submitted for this stage.");
    }
    const now = Date.now();
    insertPacket.run({
      id: randomUUID(),
      run_id: run.id,
      run_node_id: node.id,
      kind: validated.kind,
      version: node.packetVersion,
      payload_json: JSON.stringify(validated.payload),
      created_at: now,
    });
    node.status = "done";
    node.completedAt = now;
    persistRunNode(node);
    const nodes = runNodesOf(run.id);
    const intent = intentAfterPacket({
      run,
      nodes,
      completed: node,
      payload: validated.payload,
    });
    const { startKey } = applyIntent(run, nodes, intent);
    if (startKey) {
      const next = nodes.find((candidate) => candidate.templateNodeKey === startKey);
      if (next) await spawnRunNode(toRun(selectRun.get(run.id) as RunRow), next);
    }
    publish();
    return JSON.stringify({
      accepted: true,
      kind: validated.kind,
      runStatus: toRun(selectRun.get(run.id) as RunRow).status,
    });
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
    };
  }

  async function enrichNodes(nodes: PlanNode[]): Promise<z.infer<typeof planNodeSchema>[]> {
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
          child: null as z.infer<typeof childThreadSchema> | null,
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
    return {
      ...toMeta(row, nodes),
      nodes: await enrichNodes(nodes),
      harnessSnapshot: snapshotOf(row),
    };
  }

  function requirePlan(id: string): PlanRow {
    const row = selectPlan.get(id) as PlanRow | undefined;
    if (!row) throw new Error(`No plan with id ${id}`);
    return row;
  }

  function planForThread(projectId: string, threadId: string): PlanRow | null {
    return (
      (selectPlansForThread.get(projectId, threadId) as PlanRow | undefined) ??
      null
    );
  }

  async function resolveProjectId(
    threadId: string,
    fallback?: string,
  ): Promise<string> {
    if (fallback) return fallback;
    const thread = await bb.sdk.threads.get({ threadId });
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

  function assertNoLiveRun(threadId: string): void {
    if (liveRunFor(threadId)) {
      throw new Error("This thread has an active Harness run. Use start/stop/approve/retry instead of phase advance.");
    }
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
    const runChild = selectRunNodeByChild.get(threadId) as RunNodeRow | undefined;
    if (runChild) {
      const run = selectRun.get(runChild.run_id) as RunRow | undefined;
      return run?.parent_thread_id || threadId;
    }
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
    const run = latestRunFor(ownerId);
    const existingArc = readArc(ownerId);
    const phase = run
      ? phaseFromRun(run)
      : existingArc && isPhase(existingArc.phase)
        ? existingArc.phase
        : "explore";
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
    const harnessId = run
      ? MILESTONE_PIPELINE_ID
      : existingArc?.harness_id ?? snapshot?.id ?? null;
    const harnessDef = harnessId
      ? findHarness(harnessId, snapshot) ?? snapshot ?? null
      : null;
    const harness = existingArc || run ? (harnessDef ? toHarnessRef(harnessDef) : null) : null;
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
      run: run ? await toRunDetails(run) : null,
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
      "",
      `Node id: ${node.id}`,
      `Title: ${node.title}`,
      node.detail ? `Detail: ${node.detail}` : null,
      "",
      "When you finish, stop. The parent operator marks the node Done after review.",
      "Do not start the next DAG node.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  async function startPlanNode(
    planId: string,
    nodeId: string,
    parentThreadId?: string,
  ) {
    const plan = requirePlan(planId);
    const nodes = nodesOf(planId);
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`No node ${nodeId} on plan ${planId}`);
    const inflight = activeNode(nodes);
    if (inflight && inflight.id !== nodeId) {
      throw new Error(
        `Node ${inflight.id} is already in progress. Complete it before starting another.`,
      );
    }
    const blocked = node.deps.filter((dep) => {
      const parent = nodes.find((candidate) => candidate.id === dep);
      return parent && parent.status !== "done" && parent.status !== "skipped";
    });
    if (blocked.length > 0) {
      throw new Error(`Node ${nodeId} is blocked by: ${blocked.join(", ")}`);
    }
    if (node.status === "done" || node.status === "skipped") {
      throw new Error(`Node ${nodeId} is ${node.status} and cannot start.`);
    }
    if (node.status === "in_progress" && node.childThreadId) {
      return { plan: await toFull(plan) };
    }

    updateNodeStatus.run("in_progress", nodeId, planId);
    touchPlan.run(Date.now(), planId);

    if (!isSpawnablePhase(node.phase)) {
      publish();
      return { plan: await toFull(plan) };
    }

    const parentId = plan.thread_id ?? parentThreadId;
    if (!parentId) {
      updateNodeStatus.run("pending", nodeId, planId);
      throw new Error("Need a parent thread to spawn a worker/critic/promote child.");
    }
    const parent = await bb.sdk.threads.get({ threadId: parentId });
    if (!parent.environmentId) {
      updateNodeStatus.run("pending", nodeId, planId);
      throw new Error("Parent thread has no environment; cannot spawn a child.");
    }

    const choice = resolvedChoice(nodes, node);
    const title = `${PHASE_COPY[node.phase].label}: ${node.title}`.slice(0, 80);
    try {
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
      updateNodeChild.run(child.id, nodeId, planId);
    } catch (error) {
      updateNodeStatus.run("pending", nodeId, planId);
      throw error;
    }
    publish();
    return { plan: await toFull(plan) };
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
    for (const [index, node] of seedArcNodes(planId, source.phases).entries()) {
      insertNode.run({
        id: node.id,
        plan_id: planId,
        title: node.title,
        detail: node.detail,
        phase: node.phase,
        status: "pending",
        deps: JSON.stringify(node.deps),
        sort_order: index,
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
    const existing = new Set(nodesOf(planId).map((node) => node.id));
    const base = slugId(title);
    if (!existing.has(base)) return base;
    let id = `${base}-${shortId()}`;
    while (existing.has(id)) id = `${base}-${shortId()}`;
    return id;
  }

  function formatStatus(status: Awaited<ReturnType<typeof statusPayload>>): string {
    const { arc, nextNode, tier, plan, run, harness } = status;
    if (run) {
      const current = run.currentNode;
      const lines = [
        `Harness: ${run.status} (${run.id})`,
        `Task: ${run.taskPacket.objective}`,
        current
          ? `Stage: ${current.role} ${current.templateNodeKey} [${current.status}]`
          : "Stage: (none)",
      ];
      if (current?.childThreadId) lines.push(`Child: ${current.childThreadId}`);
      return lines.join("\n");
    }
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
        `Plan: ${plan.name} (${plan.id})  ${plan.doneCount}/${plan.nodeCount} done`,
      );
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
      `${plan.name} (${plan.id})  ${plan.doneCount}/${plan.nodeCount} done`,
    ];
    for (const node of plan.nodes) {
      const mark =
        node.status === "done"
          ? "x"
          : node.status === "in_progress"
            ? ">"
            : node.status === "skipped"
              ? "-"
              : " ";
      const deps = node.deps.length > 0 ? `  deps:${node.deps.join(",")}` : "";
      const child = node.childThreadId ? `  child:${node.childThreadId}` : "";
      const model = node.model ? `  ${node.providerId}/${node.model}` : "";
      lines.push(
        `[${mark}] ${node.id.padEnd(16)} ${node.phase.padEnd(8)} ${node.title}${deps}${child}${model}`,
      );
    }
    const next = nextWorkNode(plan.nodes);
    if (next) lines.push(`Next: ${next.id} — ${next.title}`);
    return lines.join("\n");
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
    };
  }

  async function initWorkspace(threadId: string) {
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
          "- Standard Harness is the default. Milestone Pipeline is optional.",
          "- Pick a provider/model per role in plugin settings, or override it on a DAG node.",
          "- Keep auditable outputs in `artifacts/`. TUIs share this harness.",
          "",
          "Commands: `bb harness status|advance|set-phase|init|plan …`",
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

  bb.rpc.register(rpcContract, {
    getStatus: async ({ threadId, projectId }) =>
      statusPayload(threadId, await resolveProjectId(threadId, projectId)),
    setPhase: async ({ threadId, projectId, phase, note }) => {
      const resolved = await resolveProjectId(threadId, projectId);
      assertNoLiveRun(threadId);
      requireLegacyArc(threadId);
      writeArc(threadId, resolved, phase, note ?? "");
      return statusPayload(threadId, resolved);
    },
    advance: async ({ threadId, projectId }) => {
      const resolved = await resolveProjectId(threadId, projectId);
      assertNoLiveRun(threadId);
      const arc = requireLegacyArc(threadId);
      const phase = isPhase(arc.phase) ? arc.phase : "explore";
      const next = nextPhase(phase);
      if (!next) throw new Error("Already at Promote — the arc is complete.");
      writeArc(threadId, resolved, next);
      return statusPayload(threadId, resolved);
    },
    rewind: async ({ threadId, projectId }) => {
      const resolved = await resolveProjectId(threadId, projectId);
      assertNoLiveRun(threadId);
      const arc = requireLegacyArc(threadId);
      const phase = isPhase(arc.phase) ? arc.phase : "explore";
      const prev = previousPhase(phase);
      if (!prev) throw new Error("Already at Explore.");
      writeArc(threadId, resolved, prev);
      return statusPayload(threadId, resolved);
    },
    listPlans: ({ projectId, threadId }) => {
      const rows = (
        threadId
          ? (selectPlansForThread.all(projectId, threadId) as PlanRow[])
          : (selectPlans.all(projectId) as PlanRow[])
      );
      return { plans: rows.map((row) => toMeta(row)) };
    },
    getPlan: async ({ id }) => {
      const row = selectPlan.get(id) as PlanRow | undefined;
      return { plan: row ? await toFull(row) : null };
    },
    createPlan: async ({ projectId, threadId, name, seedArc }) => {
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
      };
      insertPlan.run(row);
      if (seedArc !== false) {
        insertSeedNodes(row.id);
        persistPlanSnapshot(row.id, standardHarnessDefinition(now));
      }
      publish();
      return { plan: await toFull(row) };
    },
    addNode: async ({ planId, title, detail, phase, deps }) => {
      const plan = requirePlan(planId);
      const nodes = nodesOf(planId);
      const id = uniqueNodeId(planId, title);
      const resolvedDeps = deps ?? [];
      if (wouldCycle([...nodes, {
        id,
        title,
        detail: detail ?? "",
        phase: phase ?? "worker",
        status: "pending",
        deps: resolvedDeps,
        sortOrder: nodes.length,
      }], id, resolvedDeps)) {
        throw new Error("That dependency list would create a cycle.");
      }
      insertNode.run({
        id,
        plan_id: planId,
        title,
        detail: detail ?? "",
        phase: phase ?? "worker",
        status: "pending",
        deps: JSON.stringify(resolvedDeps),
        sort_order: nodes.length,
      });
      touchPlan.run(Date.now(), planId);
      publish();
      return { plan: await toFull(plan) };
    },
    startNode: ({ planId, nodeId, threadId }) =>
      startPlanNode(planId, nodeId, threadId),
    getRouting: () => ({ routing: currentRouting }),
    setRouting: async ({ slot, choice }) => {
      if (!isRoutingSlot(slot)) throw new Error(`Unknown routing slot ${slot}`);
      const next = { ...currentRouting, [slot]: choice };
      return { routing: await saveRouting(next) };
    },
    setNodeRouting: async ({ planId, nodeId, choice }) => {
      const plan = requirePlan(planId);
      const node = nodesOf(planId).find((candidate) => candidate.id === nodeId);
      if (!node) throw new Error(`No node ${nodeId} on plan ${planId}`);
      updateNodeChoice.run(
        choice?.providerId ?? null,
        choice?.model ?? null,
        choice?.reasoningLevel ?? null,
        choice?.serviceTier ?? null,
        nodeId,
        planId,
      );
      touchPlan.run(Date.now(), planId);
      publish();
      return { plan: await toFull(plan) };
    },
    setRunNodeRouting: async ({ threadId, projectId, nodeId, choice }) => {
      setRunNodeRouting(threadId, nodeId, choice);
      return statusPayload(threadId, await resolveProjectId(threadId, projectId));
    },
    suggestChoice: async () => ({ choice: await firstAvailableChoice() }),
    completeNode: async ({ planId, nodeId }) => {
      const plan = requirePlan(planId);
      const node = nodesOf(planId).find((candidate) => candidate.id === nodeId);
      if (!node) throw new Error(`No node ${nodeId} on plan ${planId}`);
      updateNodeStatus.run("done", nodeId, planId);
      touchPlan.run(Date.now(), planId);
      publish();
      return { plan: await toFull(plan) };
    },
    skipNode: async ({ planId, nodeId }) => {
      const plan = requirePlan(planId);
      const node = nodesOf(planId).find((candidate) => candidate.id === nodeId);
      if (!node) throw new Error(`No node ${nodeId} on plan ${planId}`);
      updateNodeStatus.run("skipped", nodeId, planId);
      touchPlan.run(Date.now(), planId);
      publish();
      return { plan: await toFull(plan) };
    },
    initWorkspace: ({ threadId }) => initWorkspace(threadId),
    startRun: async (input) => {
      await startRun(input);
      return statusPayload(
        input.threadId,
        await resolveProjectId(input.threadId, input.projectId),
      );
    },
    stopRun: async ({ threadId, projectId }) => {
      await stopRun(threadId);
      return statusPayload(threadId, await resolveProjectId(threadId, projectId));
    },
    approvePlan: async ({ threadId, projectId }) => {
      await approvePlan(threadId);
      return statusPayload(threadId, await resolveProjectId(threadId, projectId));
    },
    approveCorrection: async ({ threadId, projectId }) => {
      await approveCorrection(threadId);
      return statusPayload(threadId, await resolveProjectId(threadId, projectId));
    },
    retryStage: async ({ threadId, projectId, nodeId }) => {
      await retryStage(threadId, nodeId);
      return statusPayload(threadId, await resolveProjectId(threadId, projectId));
    },
    getRun: async ({ threadId, projectId, runId }) => {
      await resolveProjectId(threadId, projectId);
      const run = runId
        ? (() => {
            const row = selectRun.get(runId) as RunRow | undefined;
            return row ? toRun(row) : null;
          })()
        : latestRunFor(ownerThreadId(threadId));
      return { run: run ? await toRunDetails(run) : null };
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
        if (isReservedHarnessId(id)) throw new Error("Built-in Harnesses are immutable.");
        throw new Error(`Unknown Harness ${id}.`);
      }
      const next = applyHarnessPatch(current, draft);
      await saveCustomHarnesses(
        customHarnesses.map((item) => (item.id === id ? next : item)),
      );
      return { harness: next };
    },
    deleteHarness: async ({ id }) => {
      if (isReservedHarnessId(id)) throw new Error("Built-in Harnesses are immutable.");
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
      if (arg === "--json" || arg === "--seed" || arg === "--no-seed" || arg === "--no-scout" || arg === "--milestone") continue;
      if (
        arg === "--thread" ||
        arg === "--phase" ||
        arg === "--deps" ||
        arg === "--task" ||
        arg === "--exec-plan" ||
        arg === "--branch" ||
        arg === "--protected" ||
        arg === "--specialist" ||
        arg === "--node" ||
        arg === "--harness"
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
      { name: "start", summary: "Start Standard Harness by default, or a named Harness", usage: "bb harness start --task <text> [--harness <id>|--milestone] [--json]" },
      { name: "stop", summary: "Cancel the active Harness run", usage: "bb harness stop [--thread <id>] [--json]" },
      { name: "approve-plan", summary: "Approve the Planner packet and start Worker", usage: "bb harness approve-plan [--thread <id>] [--json]" },
      { name: "approve-correction", summary: "Start the one allowed correction Worker", usage: "bb harness approve-correction [--thread <id>] [--json]" },
      { name: "retry", summary: "Retry a failed Harness stage", usage: "bb harness retry [--node <id>] [--thread <id>] [--json]" },
      { name: "plan-list", summary: "List DAG plans for the current project", usage: "bb harness plan list [--json]" },
      { name: "plan-show", summary: "Show a DAG plan", usage: "bb harness plan show <plan-id> [--json]" },
      { name: "plan-create", summary: "Create a DAG plan (seeds the five-phase arc by default)", usage: "bb harness plan create <name> [--seed|--no-seed] [--json]" },
      { name: "plan-add", summary: "Add a node to a plan", usage: "bb harness plan add <plan-id> <title> [--phase worker] [--deps id,id] [--json]" },
      { name: "plan-next", summary: "Show the next unblocked node", usage: "bb harness plan next <plan-id> [--json]" },
      { name: "plan-start", summary: "Start a node (only one in progress at a time)", usage: "bb harness plan start <plan-id> <node-id> [--json]" },
      { name: "plan-complete", summary: "Mark a node done", usage: "bb harness plan complete <plan-id> <node-id> [--json]" },
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
            const task = takeOption(argv, "--task") ?? rest.join(" ").trim();
            if (!task) return fail("start needs --task <text>");
            await startRun({
              threadId: threadId!,
              projectId: ctx.projectId ?? undefined,
              objective: task,
              harnessId: takeOption(argv, "--harness")
                ?? (takeFlag(argv, "--milestone") ? MILESTONE_PIPELINE_ID : undefined),
              branch: takeOption(argv, "--branch"),
              execPlanPath: takeOption(argv, "--exec-plan"),
              protectedPaths: (takeOption(argv, "--protected") ?? "")
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
              runScout: !takeFlag(argv, "--no-scout"),
              specialistQuestion: takeOption(argv, "--specialist"),
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
            await stopRun(threadId!);
            const status = await statusPayload(
              threadId!,
              await resolveProjectId(threadId!, ctx.projectId),
            );
            return reply(status, formatStatus(status));
          }
          case "approve-plan": {
            const missing = needThread();
            if (missing) return missing;
            await approvePlan(threadId!);
            const status = await statusPayload(
              threadId!,
              await resolveProjectId(threadId!, ctx.projectId),
            );
            return reply(status, formatStatus(status));
          }
          case "approve-correction": {
            const missing = needThread();
            if (missing) return missing;
            await approveCorrection(threadId!);
            const status = await statusPayload(
              threadId!,
              await resolveProjectId(threadId!, ctx.projectId),
            );
            return reply(status, formatStatus(status));
          }
          case "retry": {
            const missing = needThread();
            if (missing) return missing;
            await retryStage(threadId!, takeOption(argv, "--node"));
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
            assertNoLiveRun(threadId!);
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
            assertNoLiveRun(threadId!);
            const arc = requireLegacyArc(threadId!);
            const phase = isPhase(arc.phase) ? arc.phase : "explore";
            const prev = previousPhase(phase);
            if (!prev) return fail("Already at Explore.");
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
            assertNoLiveRun(threadId!);
            requireLegacyArc(threadId!);
            writeArc(threadId!, projectId, phase);
            const status = await statusPayload(threadId!, projectId);
            return reply(status, formatStatus(status));
          }
          case "init": {
            const missing = needThread();
            if (missing) return missing;
            const result = await initWorkspace(threadId!);
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
                };
                insertPlan.run(row);
                if (!takeFlag(argv, "--no-seed")) {
                  insertSeedNodes(row.id);
                  persistPlanSnapshot(row.id, standardHarnessDefinition(now));
                }
                publish();
                const plan = await toFull(row);
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
                const plan = requirePlan(planId);
                const nodes = nodesOf(planId);
                const id = uniqueNodeId(planId, title);
                insertNode.run({
                  id,
                  plan_id: planId,
                  title,
                  detail: "",
                  phase,
                  status: "pending",
                  deps: JSON.stringify(deps),
                  sort_order: nodes.length,
                });
                touchPlan.run(Date.now(), planId);
                publish();
                const full = await toFull(plan);
                return reply(full, formatPlan(full));
              }
              case "start":
              case "complete":
              case "skip": {
                const planId = rest[1];
                const nodeId = rest[2];
                if (!planId || !nodeId) {
                  return fail(`plan ${sub} <plan-id> <node-id>`);
                }
                if (sub === "start") {
                  const started = await startPlanNode(planId, nodeId, threadId);
                  return reply(started.plan, formatPlan(started.plan));
                }
                updateNodeStatus.run(
                  sub === "complete" ? "done" : "skipped",
                  nodeId,
                  planId,
                );
                touchPlan.run(Date.now(), planId);
                publish();
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
      if (!id) return "No thread id. Pass threadId or run inside a thread.";
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
        assertNoLiveRun(id);
        requireLegacyArc(id);
        writeArc(id, projectId, phase);
      } else {
        assertNoLiveRun(id);
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
      };
      insertPlan.run(row);
      if (seedArc !== false) {
        insertSeedNodes(row.id);
        persistPlanSnapshot(row.id, standardHarnessDefinition(now));
      }
      for (const node of nodes ?? []) {
        const id = uniqueNodeId(row.id, node.title);
        insertNode.run({
          id,
          plan_id: row.id,
          title: node.title,
          detail: node.detail ?? "",
          phase: node.phase ?? "worker",
          status: "pending",
          deps: JSON.stringify(node.deps ?? []),
          sort_order: nodesOf(row.id).length,
        });
      }
      publish();
      return JSON.stringify(await toFull(row), null, 2);
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
      const nodes = nodesOf(planId);
      const target = nodeId
        ? nodes.find((node) => node.id === nodeId)
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
    description: "Mark a DAG node done after finishing that one unit of work.",
    presentation: {
      label: {
        pending: "Completing harness node",
        completed: "Completed harness node",
      },
    },
    parameters: z.object({
      planId: z.string(),
      nodeId: z.string(),
    }),
    async execute({ planId, nodeId }) {
      requirePlan(planId);
      updateNodeStatus.run("done", nodeId, planId);
      touchPlan.run(Date.now(), planId);
      publish();
      const plan = await toFull(requirePlan(planId));
      const next = nextWorkNode(plan.nodes);
      return JSON.stringify({ completed: nodeId, next, plan }, null, 2);
    },
  });

  bb.agents.registerTool({
    name: "harness_submit_result",
    description:
      "Submit the structured Harness role packet for this child stage. Submit exactly once, then stop.",
    instructions:
      "When you are a Harness role child, submit exactly one packet with harness_submit_result, then stop. Free-form output is not workflow authority.",
    presentation: {
      label: {
        pending: "Submitting harness packet",
        completed: "Submitted harness packet",
      },
    },
    parameters: z.object({
      role: z.enum(AGENT_ROLES),
      kind: z.enum(PACKET_KINDS),
      payload: z.unknown(),
    }),
    async execute({ role, kind, payload }, ctx) {
      if (!ctx.threadId) return "No thread id.";
      try {
        return await submitRunPacket({
          threadId: ctx.threadId,
          role,
          kind,
          payload,
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text }], isError: true };
      }
    },
  });

  bb.agents.configure((context) => {
    const child = selectRunNodeByChild.get(context.thread.id) as RunNodeRow | undefined;
    if (child) {
      const runRow = selectRun.get(child.run_id) as RunRow | undefined;
      if (runRow && isLiveRunStatus(runRow.status)) {
        return {
          tools: ["harness_submit_result"],
          skills: [],
          instructions: participantInstruction(child.role as AgentRole),
        };
      }
    }
    const live = liveRunFor(context.thread.id);
    if (live) {
      return {
        tools: [],
        skills: [],
        instructions: participantInstruction("operator"),
      };
    }
    const arc = readArc(context.thread.id);
    if (arc) {
      const phase = isPhase(arc.phase) ? arc.phase : "explore";
      return {
        tools: [
          "harness_get_arc",
          "harness_advance",
          "harness_create_plan",
          "harness_next_node",
          "harness_complete_node",
        ],
        skills: [],
        instructions: [
          `You are on the ${PHASE_COPY[phase].label} phase of an explicit Harness.`,
          PHASE_COPY[phase].summary,
          "Explore and Plan stay on this parent thread. Worker, Critic, and Promote spawn visible children.",
          "Work one DAG node at a time.",
        ].join(" "),
      };
    }
    return { tools: [], skills: [] };
  });

  bb.agents.contributeInstructions(({ threadId, projectId }) => {
    if (!threadId || !projectId) return null;
    const child = selectRunNodeByChild.get(threadId) as RunNodeRow | undefined;
    if (child) {
      const runRow = selectRun.get(child.run_id) as RunRow | undefined;
      if (runRow && isLiveRunStatus(runRow.status)) {
        return participantInstruction(child.role as AgentRole);
      }
      return null;
    }
    const live = liveRunFor(threadId);
    if (live) return participantInstruction("operator");
    const arc = readArc(threadId);
    if (!arc) return null;
    const phase = isPhase(arc.phase) ? arc.phase : "explore";
    return `${PHASE_COPY[phase].label}: ${PHASE_COPY[phase].summary} Explore and Plan stay on the parent. Worker, Critic, and Promote spawn children.`;
  });

  const refreshChild = ({ thread }: { thread: { id: string } }) => {
    const row = selectNodeByChild.get(thread.id) as NodeRow | undefined;
    const runRow = selectRunNodeByChild.get(thread.id) as RunNodeRow | undefined;
    if (row || runRow) publish();
  };
  bb.events.on("thread.idle", (payload) => {
    failActiveChildWithoutPacket(payload.thread.id);
    refreshChild(payload);
  });
  bb.events.on("thread.active", refreshChild);
  bb.events.on("thread.failed", (payload) => {
    failActiveChildWithoutPacket(payload.thread.id);
    refreshChild(payload);
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
