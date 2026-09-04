---
name: harness-arc
description: Drive work through Harness for BB — Planner-led arc, explicit implementation DAG, operator gates. Use when the user mentions Harness, DAG plans, task packets, role presets, Critic APPROVE/REWORK/BLOCK, or asks to run or inspect the current Harness.
---

# Harness for BB (v3 Harness Arc)

Harness is an opt-in BB orchestration mode for complex work. BB remains the harness: project/environment, instructions, skills, providers, child threads, scripts. The plugin adds role routing, context packets, gates, DAG state, and recovery.

Use it for branchy, risky, creative, or multi-step work. For trivial edits, ordinary BB chat is the correct path — the inactive panel says so.

## The arc

Setup → Exploring → Planning → PlanApproval → Executing ⇄ WorkerReview → Critiquing → FinalReview → (Promoting) → Complete. Blocked/Cancelled branch with explicit recovery. The DAG holds implementation tasks only (worker role); there are no explore/plan/critic/promote phase nodes.

Planner is the durable orchestrator in a dedicated visible thread (panel embeds it via `ThreadChat`). Explorer, Workers, Critic, and optional Promoter get isolated role threads with distinct prompts and model routing.

## Gates (human authority)

Plan approval, Worker accept/changes, Critic APPROVE/REWORK/BLOCK, rework scope, promotion start/skip, cancellation, completion. Children cannot approve themselves, start unrelated nodes, mutate routing, or complete the run.

## Commands (v3)

| Command | Effect |
| --- | --- |
| `bb harness status` | Show v3 run (or legacy arc when no v3 run exists) |
| `bb harness start --task "<text>" [--preset <id>]` | Start v3 (new starts always use v3) |
| `bb harness approve-plan` | Snapshot the Planner draft as revision 1 and start execution |
| `bb harness review-worker <node-id> --approve\|--changes "<text>"` | Accept a Worker node or return it to ready |
| `bb harness review-critic --approve\|--rework <ids> --reason "<text>"\|--block "<text>"` | Operator Critic decision; REWORK invalidates selected + downstream |
| `bb harness promote --start\|--skip` | Optional communication (off/ask/always per preset) |
| `bb harness cancel --reason "<text>"` | Stop all role children first, then cancel |
| `bb harness export` | List artifacts + manifest |
| `bb harness preset list\|show\|create\|update\|delete` | Saved role presets (First Worker / Later Workers split) |
| `bb harness legacy list\|show\|cancel` | Read-only legacy v0.1/v2 runs |

Pass `--thread <id>` outside a thread and `--json` for machine-readable output.

Legacy `plan ...`, `routing`, `set-phase`, `stop` remain read-compatible for one release and never mutate v3 state.

## Native tools (gated to the exact live attempt)

Planner: `harness_get_run_context` (full packet), `harness_run_explorer` (dispatches Explorer; its report is delivered back agent-only on submit), `harness_submit_plan_draft`, `harness_update_plan_draft`. Worker: `harness_get_node_context` (role packet slice), `harness_submit_worker_report` (one report per attempt). Critic: `harness_get_review_context` (objective, plan, all Worker reports, verification), `harness_submit_critic_report` (recommends only). Explorer: `harness_submit_exploration` (stored and delivered to Planner). Promoter: `harness_get_promotion_context`, `harness_submit_promotion`. Superseded threads (after retry/accept/new spawn) and repeat submits from the same attempt are rejected.

Legacy tools (`harness_get_arc`, `harness_create_plan`, `harness_next_node`, `harness_complete_node`) remain for legacy runs only.

## Procedure

1. Read `bb harness status`.
2. Work only the current gate and role.
3. Store evidence under `artifacts/harness/<run-id>/` (task-packet.json, exploration.md, plan.md with Mermaid, nodes/\<id\>/worker-report.md, critic.md, promotion.md, manifest.json). DB state stays authoritative.
4. Refresh after reconnects, failures, stops, or stale-revision errors. Every mutation carries expected run revision + request ID; repeated request IDs replay current state without re-applying.
5. Recover explicitly: retry/stop role, cancel after children stop, resume after reload from DB, reconcile idle/failed/deleted children, repair stale providers.

## Routing, skills, verification, and honest limits

- Saved Role Presets (Settings → Role presets) route Explorer/Planner/First Worker/Later Workers/Critic/Promoter with per-role permission and promotion/artifact policy; fresh installs inherit. The previous routing migrates once to "Migrated role routing". Snapshots freeze at Start; pending-node overrides lock after claim. Source labels: preset, node override, inherited.
- Accepting the final Worker moves straight to Critiquing. After Critic approval the panel offers Start Promoter / Skip communication; Mark complete appears only after approval — and, once promotion starts, only after the promotion report lands.
- First Worker / Later Workers approximates model specialization with fresh contexts. It is not a true context-preserving prewalk; "Prewalk" is exposed only after live proof of safe same-session switching.
- `skillHints` are validated against BB discovery and delivered as requested capabilities. The SDK can only select this plugin's own skills (`harness-planner`, `harness-worker`, `harness-critic`, `harness-promoter`); cross-plugin skill activation cannot be forced or treated as a security boundary.
- Planner records per-node verification commands; Workers run them via normal agent tools; Critic reruns the cheapest checks. No shell execution is smuggled into the server plugin.
- Provider availability is validated at Start; stale models block Start with a repair control. Token totals count distinct role threads only (deltas where available); missing values are "unavailable". No money is estimated without authoritative pricing.
