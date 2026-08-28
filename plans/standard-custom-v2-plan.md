# Standard + Custom Harness v2 implementation plan

## Goal

Simplify the plugin to one Standard/manual engine plus custom Harness definitions, then add the smallest useful audit, Critic outcome, telemetry, and customization capabilities without turning Harness into a generic workflow framework.

## Invariants

- Ordinary chats remain inactive until explicit Start Harness.
- Standard Harness is built-in, immutable, and the default.
- Existing Standard behavior remains the default: Explore/Plan parent; Worker/Critic/Promote visible children; one active DAG node.
- Active plans use a frozen Harness snapshot.
- Critic -> Worker rework stops the live Critic child before any state mutation.
- Provider/model selection remains BB-native and provider-neutral.
- Existing SQLite migrations are append-only; historical Milestone tables/data are retained but no longer active product authority.
- Plugin remains independently enableable/disableable.

## Step 1 - Remove Milestone product authority

- Remove Milestone from built-in definitions, selector, CLI flags/commands, app copy, settings copy, skill, README, agent tools, and active runtime branching.
- Delete dead run-engine source and tests after backend references are removed.
- Retain old `harness_runs`, `harness_run_nodes`, and `harness_packets` migrations/tables only as historical data compatibility. Status must ignore them for new operation.
- Starting by old Milestone id returns a clear unsupported/removed error rather than silently selecting Standard.

## Step 2 - Versioned Standard/custom definition policies

Extend definitions additively:

- `schemaVersion: 2`.
- Per phase: `execution: parent | child`, `skills: string[]`.
- Policies: `artifactPolicy: off | advisory | required`, `promoteMode: always | ask | off`, `maxCorrections: number | null`.
- Parse old custom definitions with Standard defaults; keep KV count/byte ceilings.
- Standard definition remains immutable.
- Custom editor exposes these options concisely under Advanced; no arbitrary scripts/tools/DAG builder.
- Plan snapshot stores the fully resolved v2 definition.
- Seeded plan nodes persist resolved execution mode and skills. `promoteMode: off` seeds Promote as skipped; `ask` leaves it optional/manual.
- Spawn behavior uses node execution mode rather than phase-only rules. Skills are passed through BB agent configuration for child nodes and recorded in the snapshot; unresolved behavior must fail visibly or warn, never silently rewrite the definition.

## Step 3 - Critic outcome and lightweight artifact audit

- Add append-only `plan_node_results` and `harness_artifacts` storage (or equivalent minimal relational shape).
- Critic completion requires `APPROVE`, `REWORK`, or `BLOCK` plus a short summary.
- `REWORK` uses the existing safe reopen transaction and increments correction count; enforce custom `maxCorrections` when non-null.
- `APPROVE` records authority and permits Promote.
- `BLOCK` records authority and prevents Promote completion/start until explicitly reset by the operator.
- Other node completion may include summary and artifact path references but remains simple.
- On explicit Start, create `artifacts/harness/<plan-id>/` best-effort for advisory mode; required mode fails start before durable activation if workspace is unavailable.
- DB is authoritative. Manifest JSON is a readable export and is updated best-effort after outcomes. Do not copy artifact blobs or build an evidence graph.

## Step 4 - Basic child telemetry

- Add append-only node attempt rows for spawned children.
- Capture provider/model, start/end timestamps and duration.
- Read the latest `thread/tokenUsage/updated` event at child idle/failure/completion and store input/cached/output/reasoning/total token counters when available.
- Missing usage is null. No currency estimate and no automatic routing.
- UI shows node duration/tokens, plan totals, Critic verdict, and correction count.
- Parent Explore/Plan telemetry is not attributed in v2; avoid imprecise parent-thread deltas.

## Step 5 - Verification and communication

- Update backend, pure definition, and frontend tests. Remove Milestone-specific tests and replace them with regression coverage for removal/compatibility.
- Test old custom definition parsing, frozen v2 snapshots, parent/child execution, skill injection, optional Promote, correction limits, Critic atomicity, advisory/required artifact modes, manifest paths, token event parsing, totals, ordinary-chat inactivity, project identity, unique node ids, and enable/disable-safe disposal.
- Run `npm test`, `npm run typecheck`, `bb plugin types --check .`, `bb plugin build .`, `git diff --check`.
- Reload the installed path plugin and run live CLI/UI-oriented smoke checks; confirm zero handler errors.
- Independent Critic review; one bounded correction if needed.
- Commit coherent changes. Do not tag, release, publish, open a PR, or merge without later authorization.

## Correction notes (applied)

- Plan read/mutation is owned by the parent thread and project. Critic children cannot complete or rework.
- REWORK/stop/skip stop live children before DB authority changes.
- Historical Milestone rows are settled on Start and never block Standard. Legacy `--milestone` errors.
- Custom policies keep execution, artifacts, and maxCorrections. Phase skill fields and `promoteMode: ask` are ignored; only `always`/`off` remain.
- Start claims the arc with a conditional insert and binds `arcs.plan_id`. Artifact refs stay under `artifacts/`.
- Plugin RPC is full-trust local UI/CLI, not a tenant auth boundary. Plan RPCs require the owning parent thread from `threads.get`.
- Child spawn claims pending→starting before any await. Routing is resolved before spawn; attach is a sync CAS. Start/Stop/Skip serialize per parent thread. Failed-child reconcile is CAS on status+child id.
- Inherited attempt model uses `threads.defaultExecutionOptions` when present; otherwise `inherited-unknown` with null provider/model.

## Non-goals

- Generic custom DAG engine.
- Arbitrary shell hooks or extension installation.
- Automatic model selection.
- Monetary cost estimates without provider authority.
- Destructive deletion of historical plugin data.
- Cross-TUI workspace replacement.
