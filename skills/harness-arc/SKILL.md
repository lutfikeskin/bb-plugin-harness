---
name: harness-arc
description: Drive work through the Harness plugin's Explore → Plan → Worker → Critic → Promote arc and its one-node-at-a-time DAG. Use when the user mentions the harness, the five-phase arc, prewalk, DAG plans, artifacts/ discipline, or asks to advance, rewind, or plan the current thread.
---

# Harness arc

The Harness plugin is the fulcrum between expectations and the model. Roles stay isolated. A prompt that plans, implements, and critiques itself confuses its own objectives.

Arc:

1. **Explore** — map the problem. Do not implement yet. Stays on the parent thread.
2. **Plan** — freeze a plan packet. v1 always continues to one Worker. Stays on a child thread.
3. **Worker** — implement the approved plan as one bounded unit. Spawns a child thread.
4. **Critic** — simplify and push back. Returning to Worker is normal. Spawns a child thread.
5. **Promote** — the job is unfinished until you communicate it. Spawns a child thread.

## Commands

| Command | Effect |
| --- | --- |
| `bb harness status` | Current phase, resolved model, next DAG node |
| `bb harness advance` | Move one phase forward |
| `bb harness rewind` | Move one phase back (critic → worker) |
| `bb harness set-phase <phase>` | Jump to explore\|plan\|worker\|critic\|promote |
| `bb harness init` | Create `artifacts/`, `plans/`, and `HARNESS.md` |
| `bb harness plan create "<name>"` | Seed a five-node DAG (add `--no-seed` for empty) |
| `bb harness plan list` / `show <id>` | List or inspect a plan |
| `bb harness plan next <id>` | Next unblocked node |
| `bb harness plan start <id> <node>` | Start a node (spawns a child for worker/critic/promote) |
| `bb harness plan complete <id> <node>` | Mark that node done |
| `bb harness plan add <id> <title> [--phase worker] [--deps a,b]` | Add a node |

Pass `--thread <id>` when you are not already inside that thread. Add `--json` when the output drives code.

Native tools: `harness_get_arc`, `harness_advance`, `harness_create_plan`, `harness_next_node`, `harness_complete_node`.

## Procedure

1. `bb harness status` (or `harness_get_arc`) before changing anything.
2. Stay in the current phase. If you need a plan, advance to Plan and write a DAG instead of improvising a giant todo list in prose.
3. Worker: start the next node, finish it, complete it, then take the following node. Never start two nodes.
4. Keep auditable outputs in `artifacts/`. Do not dump scratch into the repo root.
5. After Worker, advance to Critic. If critique sends you back, rewind and reopen the failing node.
6. Promote last: tell the people who need to know.

## Role routing

Settings → Role routing picks a real provider and model for:

- Explore / Plan (advisory — parent composer)
- Worker first node / later worker nodes
- Critic / Promote

A DAG node can override that slot. Unset means inherit the parent thread's provider/model. Starting a worker/critic/promote node still spawns a child for isolation.

Do not auto-complete a node when the child goes idle. The operator clicks Done.
