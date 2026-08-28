# bb-plugin-harness

A BB plugin for [Scott Fryxell's harness philosophy](https://scott-fryxell.github.io/blog/the-harness-is-the-thing): the harness is the fulcrum between your expectations and the model.

**Explore → Plan → Worker → Critic → Promote.** Isolated roles. Explicit DAG. One node at a time. Auditable output in `artifacts/`.

Worker, Critic, and Promote spawn a **child thread**. Explore and Plan stay on the parent. Pick a real provider/model per role in plugin settings, or override it on a DAG node.

## Surfaces

- **Sidebar → Harness** — per-thread arc, role routing band, DAG checklist, child-thread status
- **Thread panel → Harness** — the same UI on the conversation
- **Settings → Role routing** — host provider/model picker per role
- **Composer banner** — current phase and next node
- **`bb harness`** — status, advance, init, plan create/list/show/next/start/complete
- **Agent tools** — `harness_get_arc`, `harness_advance`, `harness_create_plan`, `harness_next_node`, `harness_complete_node`
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
bb harness plan create "Ship the feature"
bb harness plan start <plan-id> worker
bb harness advance
bb harness init
```

`init` writes `HARNESS.md`, `artifacts/`, and `plans/` into the thread's workspace. Existing files are left alone.

Starting a worker/critic/promote node spawns a visible child thread with that role's provider/model (or the parent thread's, if the slot is unset). Click **Done** on the parent Harness panel after reviewing — idle does not auto-complete the node.

## Remove

```
bb plugin disable harness    # pause, keep data
bb plugin remove harness     # unregister + delete plugin SQLite
rm -rf ~/bb-plugin-sources/bb-plugin-harness
```

Nothing is written into BB core. `bb harness init` only adds `artifacts/`, `plans/`, and `HARNESS.md` in the workspace you pointed it at.

## Settings

Plugin settings → **Role routing**: one picker per slot (Explore, Plan, Worker first, Worker later, Critic, Promote). Clear a slot to inherit the parent thread.

Per-node overrides live on the DAG row in the Harness panel.

## Not in this version

Headless product-driver (poster-driver / `npm run make:animation`) is deferred.
