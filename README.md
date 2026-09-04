# Harness for BB

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Harness is **Harness for BB**: an opt-in, operator-driven coding workflow. Its concrete feature is the **Harness Arc** — Planner-led orchestration with an explicit implementation DAG:

```text
Setup -> Exploring -> Planning -> PlanApproval -> Executing <-> WorkerReview -> Critiquing -> FinalReview -> (Promoting) -> Complete
```

> v0.2 is an article-aligned redesign (schema v3). New starts always use v3. Legacy v0.1/v2 arcs/plans remain readable under `bb harness legacy` — see [MIGRATION.md](MIGRATION.md).

The plugin is inspired by [Scott Fryxell's harness idea](https://scott-fryxell.github.io/blog/the-harness-is-the-thing): keep the model inside a system of clear roles, durable work artifacts, and user-controlled handoffs rather than asking one chat turn to explore, plan, implement, and critique itself.

Harness is a standalone BB plugin repository. It is not a replacement for BB, your repository, or your agent provider.

## What it gives you

- **Explicit opt-in:** ordinary BB chats remain unchanged until you select **Start Harness**. Trivial work should stay in ordinary chat.
- **Planner as orchestrator:** a dedicated visible Planner thread; Explorer, Workers, Critic, and optional Promoter get isolated role threads.
- **Real implementation DAG:** the Planner proposes worker-only tasks with dependencies, acceptance criteria, verification commands, and artifacts. You approve the exact DAG that executes.
- **Versioned task packets:** every role receives a bounded packet generated from database state; large reports live in artifacts and travel as links + summaries.
- **Role presets (Settings → Role routing):** saved Explorer/Planner/First Worker/Later Workers/Critic/Promoter routing with per-role permission, promotion/artifact policy, and pending-node overrides (locked after claim).
- **Operator gates:** plan approval, Worker accept/changes, Critic APPROVE/REWORK/BLOCK, promotion start/skip, cancellation, completion. Children cannot self-approve.
- **Recovery:** retry/stop roles, resume after reload, reconcile idle/failed/deleted children, repair stale providers. No recovery silently marks work successful.
- **Audit trail:** durable plan state, node results, artifact references, child-thread links, and child token/duration telemetry.
- **Provider-neutral routing:** choose BB provider/model/reasoning settings per role or override an individual node.

## What it is not

Harness deliberately does **not** try to be a generic workflow-programming platform. It does not provide arbitrary custom DAG engines, automatic model switching, true context-preserving prewalk, fabricated cost estimates, shell hooks, product drivers, a separate workspace/sandbox, hidden fully automatic orchestration, or a replacement for BB Workflows.

Use [BB Workflows](https://getbb.app) when you need a script-driven, automatic fan-out/fan-in pipeline. Use Harness when you want a visible, long-lived, human-controlled handoff between coding roles.

**Honest limits:** First Worker / Later Workers routing approximates model specialization with fresh contexts — it is not true prewalk. `skillHints` are validated requests, not forced cross-plugin activation. Critic/Promote `accept-edits` is least-privilege defense in depth, not a filesystem sandbox. Token totals count distinct role threads only; missing values are `unavailable`; no money is estimated.

## Mental model

### The arc

1. **Start Harness** — create a Planner thread.
2. **Explorer** investigates and returns a structured report.
3. **Planner** submits an implementation-only DAG.
4. **Operator approves** the plan (or requests revision).
5. **Workers** execute ready nodes in topological order.
6. **Critic** reviews objective, plan, reports, and checks.
7. **Operator decides** APPROVE, REWORK, or BLOCK.
8. **Promoter** optionally communicates the result.
9. **Done** — operator marks complete.

### The plan

The DAG contains implementation tasks only — no `explore`, `plan`, `critic`, or `promote` phase nodes. Each node has a title, objective, dependencies, acceptance criteria, verification commands, expected artifacts, skill hints, and an optional routing override. Critic cannot start until every required Worker node is done. Rework invalidates the selected nodes and any downstream nodes whose inputs are no longer trustworthy.

## Install

### From a local checkout (recommended while testing)

```bash
cd ~/bb-plugin-sources/bb-plugin-harness
npm install
bb plugin install . --yes
```

A local-path install loads the source directly; run `bb plugin build .` and `bb plugin reload harness` to pick up changes.

### From the public Git release

```bash
bb plugin install git:https://github.com/lutfikeskin/bb-plugin-harness.git@^0.2.0
```

BB resolves the newest compatible semver tag.

### Verify

```bash
bb plugin list
bb harness --help
```

## Quick start

Open a BB thread for the task, then either use **Harness** in the thread panel/sidebar or run:

```bash
bb harness start --task "Add an audit export"
```

That creates a v3 Harness run and starts the Planner/Explorer flow. Inspect state with:

```bash
bb harness status
```

Typical CLI flow:

```bash
# After Explorer reports and Planner proposes the DAG:
bb harness approve-plan

# Review a completed Worker node:
bb harness review-worker <node-id> --approve
# or request changes:
bb harness review-worker <node-id> --changes "add a regression test for empty exports"

# After all Workers are accepted, record the Critic decision:
bb harness review-critic --approve
# or:
bb harness review-critic --rework <node-ids> --reason "empty export results not handled"
# or:
bb harness review-critic --block "security model is unclear"

# Optionally run Promoter or skip:
bb harness promote --start
# or:
bb harness promote --skip
```

## Role routing and presets

**Settings → Role routing** sets the provider/model/reasoning for Explorer, Planner, First Worker, Later Workers, Critic, and Promoter. A per-node override wins over the role default. Saved presets snapshot into the run at Start; later edits affect future runs only.

**First Worker / Later Workers** approximates model specialization with fresh contexts. It is not a true context-preserving prewalk; Harness never switches models by itself.

## Artifacts and audit trail

For each run, Harness writes readable exports under:

```text
artifacts/harness/<run-id>/
  task-packet.json
  exploration.md
  plan.md
  nodes/<node-id>/worker-report.md
  critic.md
  promotion.md   # only if run
  manifest.json
```

The database remains authoritative. Artifact paths are confined to `artifacts/`, rejecting `..`, absolute paths, URLs, and control characters.

## CLI reference

Run `bb harness --help` for the installed version.

### v3 commands

| Command | Purpose |
| --- | --- |
| `bb harness status [--thread <id>] [--json]` | Show v3 run or legacy fallback. |
| `bb harness start --task "..." [--preset <id>]` | Start a v3 Harness. |
| `bb harness approve-plan [--thread <id>] [--json]` | Approve Planner draft and start execution. |
| `bb harness review-worker <node-id> --approve or --changes "<text>"` | Accept or return a Worker. |
| `bb harness review-critic --approve or --rework <ids> --reason "<text>" or --block "<text>"` | Operator Critic decision. |
| `bb harness promote --start or --skip` | Optional communication. |
| `bb harness cancel --reason "<text>"` | Stop children, then cancel. |
| `bb harness export [--thread <id>]` | List artifacts and manifest. |
| `bb harness preset list or show or create or update or delete ...` | Manage role presets. |
| `bb harness legacy list or show or cancel ...` | Read-only legacy v0.1/v2 runs. |

### Legacy commands (read-compatible, never mutate v3)

| Command | Purpose |
| --- | --- |
| `bb harness set-phase <phase> --reason "..."` | Audited legacy recovery. |
| `bb harness stop [--reason "..."]` | Legacy cancel. |
| `bb harness plan list or show or create or add or next or start or complete or reopen or reset-block ...` | Legacy plan operations. |
| `bb harness routing [show or set or clear] ...` | Legacy routing. |

## Agent integration and skills

Harness ships five skills:

- `skills/harness-arc/SKILL.md`
- `skills/harness-planner/SKILL.md`
- `skills/harness-worker/SKILL.md`
- `skills/harness-critic/SKILL.md`
- `skills/harness-promoter/SKILL.md`

### Native role tools

**Planner:** `harness_get_run_context`, `harness_run_explorer`, `harness_submit_plan_draft`, `harness_update_plan_draft`

**Explorer:** `harness_submit_exploration`

**Worker:** `harness_get_node_context`, `harness_submit_worker_report`

**Critic:** `harness_get_review_context`, `harness_submit_critic_report`

**Promoter:** `harness_get_promotion_context`, `harness_submit_promotion`

Legacy tools (`harness_get_arc`, `harness_create_plan`, `harness_next_node`, `harness_complete_node`) remain for legacy runs only.

## Recovery

- Retry a failed role attempt.
- Stop an active role and return the node to ready.
- Cancel after all children stop.
- Resume after plugin reload.
- Reconcile idle/failed/deleted/stopped children.
- Repair stale providers before retry.

No recovery action silently marks work successful.

## How Harness differs from BB Workflows

| Harness | BB Workflows |
| --- | --- |
| Operator-driven and long-lived | Script-driven and automatic |
| Visible child threads | Usually hidden workers |
| Human review between nodes | Automatic progression |
| Durable interactive DAG + Critic | Deterministic fan-out/fan-in/loops |
| Can pause for hours/days | Normally runs to execute a script |

## Development

Requirements:

- Node.js compatible with the package dependencies
- BB `>=0.40`
- BB Plugin SDK `>=0.4.34`

```bash
npm install
npm test
npm run typecheck
bb plugin types --check .
bb plugin build .
```

During development:

```bash
bb plugin dev .
```

Or rebuild and reload manually:

```bash
bb plugin build .
bb plugin reload harness
```

The test suite covers v3 DAG/state/packets/reports/presets/artifacts/tokens, happy path, rework, failure/recovery, ownership, CLI, panel states, accessibility, contract, and legacy migration.

## Enable, disable, remove, update

```bash
bb plugin disable harness   # unload; retain data
bb plugin enable harness      # load again
bb plugin reload harness      # reload local-path install
bb plugin remove harness      # delete plugin-scoped data
```

For tagged releases:

```bash
bb plugin install git:https://github.com/lutfikeskin/bb-plugin-harness.git@^0.2.0
```

## Compatibility and migration

- v3 uses new `harness_v3_*` tables; v0.1/v2 tables are never rewritten or deleted.
- New starts always use v3. Legacy arcs/plans remain readable under `bb harness legacy`.
- Existing routing migrates once into a saved preset named **"Migrated role routing"**.
- Active legacy runs are not guessed into v3; finish them with legacy commands or explicitly cancel them.

See [MIGRATION.md](MIGRATION.md) for the full guide.

## License

[MIT](LICENSE)
