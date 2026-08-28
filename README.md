# bb-plugin-harness

A BB plugin for [Scott Fryxell's harness idea](https://scott-fryxell.github.io/blog/the-harness-is-the-thing): the harness is the fulcrum between your expectations and the model.

**Explore → Plan → Worker → Critic → Promote.** Isolated roles. Explicit DAG. One node at a time. Auditable output in `artifacts/`.

**Standard Harness** is the built-in, immutable default. Explore and Plan stay on the parent thread. Worker, Critic, and Promote spawn a visible child. Critic completes with **APPROVE**, **REWORK**, or **BLOCK**. Promote communicates. It is not a template.

**Create Harness** clones Standard into a saved custom definition: name, description, per-phase instructions, parent/child execution, artifact policy, promote mode (`always` or `off`), and a correction ceiling. Built-ins are immutable. Starting snapshots the resolved definition into that thread's plan. This plugin injects only its own `harness-arc` skill; arbitrary BB skill names are not a custom-Harness control.

Ordinary chats stay inactive until you explicitly Start Harness.

Milestone Pipeline is removed from the product. Historical SQLite tables stay in place so existing plugin databases are not destructively migrated.

## Surfaces

- **Sidebar → Harness** — Start form and Standard/custom DAG
- **Thread panel → Harness** — the same UI on the conversation
- **Settings → Role routing** — host provider/model picker per role
- **Composer banner** — current phase when a Harness is active
- **`bb harness`** — status, start (`--harness <id>`), advance, init, plan commands
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
bb harness start --task "Ship the feature"
bb harness start --task "Ship the feature" --harness <custom-id>
bb harness plan create "Ship the feature"
bb harness plan start <plan-id> worker
bb harness plan complete <plan-id> critic --verdict APPROVE --summary "Holds"
bb harness advance
bb harness init
```

`init` writes `HARNESS.md`, `artifacts/`, and `plans/` into the thread's workspace. Existing files are left alone.

Starting Standard/custom writes an explicit arc and a uniquely-id'd seeded plan. No child is spawned until you Start a child-execution node. Click **Done** on the parent after review. Critic uses explicit verdicts.

On Start, advisory artifact policy best-effort creates `artifacts/harness/<plan-id>/`. Required mode fails before the run is activated if the workspace is unavailable.

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
Custom Harnesses keep the five arcs. They do not become a generic DAG builder, hook runner, or automatic model router.
Child token totals come from BB `thread/tokenUsage/updated` when present; missing usage stays null and no cost is invented.
Arbitrary external skill injection is not supported. Parent-execution nodes receive frozen custom title and detail plus `harness-arc`.
