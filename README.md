# bb-plugin-harness

A BB plugin for [Scott Fryxell's harness philosophy](https://scott-fryxell.github.io/blog/the-harness-is-the-thing): the harness is the fulcrum between your expectations and the model.

**Explore → Plan → Worker → Critic → Promote.** Isolated roles. Explicit DAG. One node at a time. Auditable output in `artifacts/`.

**Standard Harness** is the built-in default. Explore and Plan stay on the parent thread. Worker, Critic, and Promote spawn a visible child. Critic may rewind Worker. Promote communicates. It is not a template.

**Milestone Pipeline** is an optional specialized Harness (Scout, optional Specialist, Planner approval, one Worker + Tester, Reviewer, one correction, Promote). It is never auto-selected.

**Create Harness** clones Standard Harness into a saved custom definition (name, description, and per-phase instructions). Built-ins are immutable. Starting snapshots the chosen definition into that thread's plan.

Ordinary chats stay inactive until you explicitly Start Harness.

## Surfaces

- **Sidebar → Harness** — Start form, Standard/custom DAG, or Milestone run
- **Thread panel → Harness** — the same UI on the conversation
- **Settings → Role routing** — host provider/model picker per role
- **Composer banner** — current phase when a Harness is active
- **`bb harness`** — status, start (`--harness <id>` or `--milestone`), advance, init, plan commands
- **Agent tools** — `harness_get_arc`, `harness_advance`, `harness_create_plan`, `harness_next_node`, `harness_complete_node`, plus `harness_submit_result` on Milestone children
- **Skill** — `skills/harness-arc`

## Install

```
cd ~/bb-plugin-sources/bb-plugin-harness
npm install
bb plugin install . --yes
```

Reload after edits: `bb plugin reload harness`, or `bb plugin dev`.

## Use

From a thread:

```
bb harness status
bb harness start --task "Ship the feature"
bb harness start --task "Ship the feature" --harness milestone-pipeline
bb harness start --task "Ship the feature" --milestone
bb harness plan create "Ship the feature"
bb harness plan start <plan-id> worker
bb harness advance
bb harness init
```

`init` writes `HARNESS.md`, `artifacts/`, and `plans/` into the thread's workspace. Existing files are left alone.

Starting Standard/custom writes an explicit arc and a uniquely-id'd seeded plan. No child is spawned until you Start a Worker, Critic, or Promote node. Click **Done** on the parent after review.

Starting Milestone Pipeline uses the durable run engine and spawns the first ready role child immediately.

## Remove

```
bb plugin disable harness    # pause, keep data
bb plugin remove harness     # unregister + delete plugin SQLite
rm -rf ~/bb-plugin-sources/bb-plugin-harness
```

Nothing is written into BB core. `bb harness init` only adds `artifacts/`, `plans/`, and `HARNESS.md` in the workspace you pointed it at.

## Settings

Plugin settings → **Role routing**: one picker per slot (Explore/Scout, Plan/Planner, Worker first, Worker later, Critic/Reviewer, Promote). Clear a slot to inherit the parent thread.

Per-node overrides live on the DAG row in the Harness panel.

## Not in this version

Headless product-driver (poster-driver / `npm run make:animation`) is deferred.
Custom Harnesses keep the five arcs and one sequential node per phase; they do not change the Milestone engine.
