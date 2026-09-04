# Migration to v3 (v0.2)

## What changed

- **New tables, same database.** v3 uses `harness_v3_*` tables. v0.1/v2 tables (`arcs`, `plans`, `plan_nodes`, …) are never rewritten or deleted.
- **New starts always use v3.** `bb harness start` creates a Planner-led run with an explicit implementation-only DAG.
- **Old runs stay readable.** `bb harness legacy list|show|cancel` exposes legacy plans. Active legacy runs are not guessed into v3 — finish them with the legacy path or explicitly cancel/archive them.
- **Routing migrated once.** The previous six-slot routing becomes a saved preset named **"Migrated role routing"** (future runs snapshot presets; later edits affect future runs only). Fresh installs default every role to inherit.
- **Legacy CLI/commands are read-compatible.** Old `plan ...`, `routing`, `set-phase`, `stop` paths cannot mutate v3 state.

## Before upgrading

1. Note the current branch and dirty diff (`git status`, `git diff`).
2. Back up the Harness database (BB storage; keep a copy before loading v0.2).
3. Run `PRAGMA quick_check` on the original and the backup.
4. Sync the plugin SDK (`bb plugin types`, `npm install`).

## Removal schedule

Legacy read support stays for one stable release and is reassessed only after an explicit export path exists. Historical rows never block new runs.

## First-use checklist (no CLI required)

1. Open any thread → Harness panel → describe the task → Start v3 Harness.
2. Let Explorer report (or skip with a reason), let Planner propose 2–3 tasks.
3. Edit a dependency or acceptance criterion by requesting a revision, then Approve plan.
4. Override one pending Worker model from the run panel (locks after claim).
5. Accept each Worker (the final acceptance moves straight to Critiquing), let Critic report, decide APPROVE/REWORK/BLOCK.
6. After approval use Start Promoter or Skip communication, then Mark complete (gated on the promotion report once promotion starts) and open every artifact.
