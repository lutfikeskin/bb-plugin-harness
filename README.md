# Harness for BB

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Harness is an **opt-in, operator-driven coding workflow** for [BB](https://getbb.app). It turns a complex task into an explicit, durable lifecycle:

```text
Explore -> Plan -> Worker -> Critic -> Promote
```

The plugin is inspired by [Scott Fryxell's harness idea](https://scott-fryxell.github.io/blog/the-harness-is-the-thing): keep the model inside a system of clear roles, durable work artifacts, and user-controlled handoffs rather than asking one chat turn to explore, plan, implement, and critique itself.

Harness is a standalone BB plugin repository. It is not a replacement for BB, your repository, or your agent provider.

## What it gives you

- **Explicit opt-in:** ordinary BB chats remain unchanged until you select **Start Harness**.
- **Standard Harness:** one immutable built-in default with five roles and a seeded DAG.
- **Custom Harnesses:** saved copies of Standard with bounded, validated policy changes.
- **One active node:** the plugin prevents simultaneous DAG execution nodes on a Harness plan.
- **Visible role children:** Standard Worker, Critic, and Promote work run as visible child threads by default.
- **Critic authority:** Critic records `APPROVE`, `REWORK`, or `BLOCK` rather than a vague completion.
- **Audit trail:** durable plan state, node results, artifact references, child-thread links, and child token/duration telemetry.
- **Provider-neutral routing:** choose BB provider/model/reasoning settings per role or override an individual node.
- **Safety around lifecycle races:** Start, Stop, Skip, child attachment, failed-child reconciliation, and old data migration have regression coverage.

## What it is not

Harness deliberately does **not** try to be a generic workflow-programming platform.

It does not provide:

- arbitrary custom DAG engines;
- automatic model switching or fabricated cost estimates;
- shell hooks, product drivers, or extension installation from a Harness definition;
- a separate workspace, sandbox, checkout, or permission escalation layer;
- hidden, fully automatic background orchestration by default;
- a replacement for BB Workflows.

Use [BB Workflows](https://getbb.app) when you need a script-driven, automatic fan-out/fan-in pipeline. Use Harness when you want a visible, long-lived, human-controlled handoff between coding roles.

---

## Mental model

### The arc

The Standard Harness starts with this lifecycle:

| Phase | Default execution | Purpose |
| --- | --- | --- |
| **Explore** | Parent thread | Read the system and isolate the actual constraint. Do not implement. |
| **Plan** | Parent thread | Turn the exploration into an explicit DAG: one node, one outcome, named dependencies. |
| **Worker** | Visible child thread | Implement exactly one ready node. |
| **Critic** | Visible child thread | Independently simplify, question, and decide whether the work holds. |
| **Promote** | Visible child thread | Communicate the completed result, verification, risks, and next milestone. |

The default shape is intentional. Explore and Plan remain conversational and operator-led on the parent. Execution and independent review are isolated in child threads where they can be inspected directly.

### The plan

Starting a Harness creates a durable five-node seed plan:

```text
explore -> plan -> worker -> critic -> promote
```

You can add more nodes and dependencies to the plan. The plugin validates dependencies and cycles, names node IDs per plan, and allows only one `starting` or `in_progress` node at a time.

A bare phase name is accepted as a convenient alias for a seeded node. For example, both of these address the initial Worker node:

```bash
bb harness plan start <plan-id> worker
bb harness plan start <plan-id> <plan-id>-worker
```

### The operator remains in charge

Harness does not auto-complete a node merely because its child thread becomes idle. The operator reviews the work and explicitly completes the node. Critic requires a structured decision:

| Verdict | Effect |
| --- | --- |
| `APPROVE` | Records approval; the plan may move to Promote. |
| `REWORK` | Stops any live Critic child, reopens the latest completed Worker, and increments the correction count. |
| `BLOCK` | Records the block and prevents Promote until the operator resets it. |

A custom Harness may set a maximum correction count. `null` means the operator controls the number of rework loops.

---

## Install

### From the public Git release

```bash
bb plugin install git:https://github.com/lutfikeskin/bb-plugin-harness.git@^0.1.1
```

The repository uses immutable semver tags. BB resolves the newest compatible tag in the requested range.

### From a local checkout

```bash
cd ~/bb-plugin-sources
 git clone https://github.com/lutfikeskin/bb-plugin-harness.git
cd bb-plugin-harness
npm install
bb plugin install . --yes
```

A local-path install is useful while developing because BB loads the source directory directly.

### Verify installation

```bash
bb plugin list
bb harness --help
```

The plugin contributes a sidebar panel, thread-panel action, header action, command-palette entry, composer banner, settings section, CLI command, agent tools, and `harness-arc` skill.

---

## Quick start

Open the BB thread for the task, then either use **Harness** from the thread panel/sidebar or run:

```bash
bb harness start --task "Add an audit export"
```

That creates a Standard Harness on the current thread. It does **not** create a child immediately.

Inspect the state:

```bash
bb harness status
```

Work the parent-thread phases first:

```bash
bb harness plan start <plan-id> explore
bb harness plan complete <plan-id> explore
bb harness advance

bb harness plan start <plan-id> plan
bb harness plan complete <plan-id> plan
bb harness advance
```

Start the Worker. This creates a visible child thread under the parent:

```bash
bb harness plan start <plan-id> worker
```

After reviewing the child’s work, complete the Worker and advance:

```bash
bb harness plan complete <plan-id> worker \
  --summary "Implemented export and added coverage" \
  --artifacts artifacts/harness/<plan-id>/worker-report.md
bb harness advance
```

Then start Critic and record its verdict:

```bash
bb harness plan start <plan-id> critic
bb harness plan complete <plan-id> critic \
  --verdict APPROVE \
  --summary "Implementation is bounded, tested, and ready to communicate"
```

If Critic requests rework instead:

```bash
bb harness plan complete <plan-id> critic \
  --verdict REWORK \
  --summary "Handle empty export results and add a regression test"
```

Finally, start and complete Promote if it is enabled:

```bash
bb harness advance
bb harness plan start <plan-id> promote
bb harness plan complete <plan-id> promote --summary "Shared release notes and verification"
```

For a stopped or blocked run, inspect status before taking another action:

```bash
bb harness status --json
```

---

## Standard Harness

**Standard Harness** is the built-in default. It is immutable: it cannot be edited or deleted, so plugin upgrades have a stable, documented baseline.

Its defaults are:

```text
Execution
  Explore  parent
  Plan     parent
  Worker   child
  Critic   child
  Promote  child

Artifacts
  advisory

Promote
  always

Corrections
  unlimited, operator-controlled
```

The Standard definition is not a “template” that can be altered in place. It is the reference behavior from which a custom Harness can be created.

---

## Custom Harnesses

Choose **Create Harness** in the start form to clone Standard into a persistent custom definition. Custom definitions are stored in plugin KV storage, with a maximum of 32 definitions or 200 KB total serialized state.

A custom Harness can change:

| Setting | Meaning |
| --- | --- |
| Name and description | The saved definition’s identity in the selector. |
| Per-phase title and instructions | The frozen text placed on each seeded plan node. |
| Per-phase execution | `parent` keeps work in the parent thread; `child` opens a visible BB child thread. |
| Artifact policy | `off`, `advisory`, or `required`. |
| Promote mode | `always` seeds Promote; `off` seeds it as skipped. |
| Maximum corrections | `0`–`99`, or unlimited. |

It cannot change:

- the five phase names or their order;
- the durable manual/DAG engine;
- arbitrary tool allowlists, shell hooks, extensions, or arbitrary external skills;
- the immutable Standard Harness.

### Snapshot semantics

When a Harness starts, the resolved definition is copied into the plan record. Editing or deleting the saved custom definition later does **not** rewrite an active or completed plan.

This matters for auditability: a result can always be read against the actual instructions and policy it began with.

### Custom execution example

A custom Harness might run a planning review in a child thread while keeping implementation standard:

```text
Explore  parent
Plan     child
Worker   child
Critic   child
Promote  off
```

The plan stays sequential. This is a controlled role-routing change, not an automatic multi-agent graph generator.

---

## Artifacts and audit trail

### Workspace files

Harness can use a thread’s environment workspace for readable evidence:

```text
artifacts/harness/<plan-id>/
  manifest.json
```

The manifest is a best-effort, human-readable export of recorded artifact references. The plugin database remains authoritative.

Run this if you want the conventional top-level harness files as well:

```bash
bb harness init
```

It creates, without overwriting existing files:

```text
HARNESS.md
artifacts/.gitkeep
plans/README.md
```

### Artifact policies

| Policy | Start behavior |
| --- | --- |
| `off` | Does not create a Harness artifact directory. |
| `advisory` | Best-effort creates `artifacts/harness/<plan-id>/`; a missing workspace does not block the run. |
| `required` | Requires a usable thread environment and artifact directory before activating the Harness. |

Artifact references must be relative to `artifacts/`. Absolute paths, drive paths, URLs, `.` segments, and `..` traversal are rejected.

Examples:

```text
Allowed:     artifacts/harness/abc123/worker-report.md
Rejected:    /tmp/report.md
Rejected:    ../../secrets.txt
Rejected:    artifacts/../secrets.txt
```

### Persisted audit data

The plugin stores the following in its SQLite database:

- arc state and the authoritative active plan ID;
- plan and DAG-node state;
- dependencies, execution mode, routing overrides, and child links;
- frozen Harness snapshots;
- node completion summaries and Critic verdicts;
- correction count and Critic block state;
- artifact references;
- child attempts, duration, provider/model metadata when available, and token counters.

Old Milestone Pipeline tables remain only for non-destructive migration compatibility. Milestone is no longer a selectable or runnable Harness engine.

---

## Routing, prewalk, and telemetry

### Role routing

**Settings -> Role routing** lets you choose a BB provider, model, reasoning level, and optional service tier for:

```text
Explore
Plan
Worker (first node)
Worker (later nodes)
Critic
Promote
```

A per-node override wins over the role default. If no setting exists, the child inherits the parent thread’s execution settings where BB exposes them.

The split between the first and later Worker slots supports a prewalk-style strategy:

```text
Explore / Plan / first Worker / Critic / Promote: stronger model if useful
Later Workers:                              lower-cost model if appropriate
```

This is a routing convenience, not an automatic cost optimizer. Harness never switches models by itself.

### Telemetry

Every spawned child produces an attempt record. When BB provides a `thread/tokenUsage/updated` event, Harness records:

- input tokens;
- cached input tokens;
- output tokens;
- reasoning output tokens;
- total tokens;
- start/end timestamps and duration.

If BB cannot expose usage or inherited model data, the relevant values stay `null` and the source is reported as `inherited-unknown`. The plugin never invents token counts or dollar costs.

Parent-thread Explore and Plan work is intentionally not attributed through an imprecise thread-delta estimate.

---

## User interfaces

| Surface | Use |
| --- | --- |
| Sidebar -> Harness | Start a Harness and inspect its plan from the project context. |
| Thread panel -> Harness | Work the active thread’s plan, routing, verdicts, and node controls. |
| Thread header action | Opens the Harness panel for the current thread. |
| Command palette | `Harness: open panel`. |
| Composer banner | Shows the current phase only while a Harness is active. |
| Settings -> Role routing | Sets persistent role defaults. |
| `bb harness` | Supports scripting and agent-driven operation. |

The start form labels the selection **Harness**, not template. Standard is selected by default; saved custom Harnesses appear beside it.

---

## CLI reference

Run `bb harness --help` for the version installed on your BB server.

| Command | Purpose |
| --- | --- |
| `bb harness status [--thread <id>] [--json]` | Show the active arc, plan, next node, routing, outcomes, and telemetry. |
| `bb harness start --task "..." [--harness <id>]` | Explicitly start Standard or a saved custom Harness. |
| `bb harness stop` | Stop active children safely and end the active Harness arc. |
| `bb harness advance` / `rewind` | Move the visible lifecycle; Critic -> Worker rewind safely reopens the latest Worker. |
| `bb harness set-phase <phase>` | Move to a named phase. |
| `bb harness init` | Create optional workspace documentation and artifact directories. |
| `bb harness plan list` / `show <id>` | List or inspect plans. |
| `bb harness plan create "Name"` | Create a separate seeded plan. |
| `bb harness plan add <id> "Title" --phase worker --deps a,b` | Add a custom node with validated dependencies. |
| `bb harness plan next <id>` | Print the next ready or active node. |
| `bb harness plan start <id> <node>` | Start a ready node. Child-execution nodes create visible child threads. |
| `bb harness plan complete <id> <node>` | Complete a node; Critic requires `--verdict` and `--summary`. |
| `bb harness plan reset-block <id>` | Clear a recorded Critic BLOCK so the operator can continue deliberately. |

Use `--json` when another tool or script will consume the result.

### Example: add a bounded Worker node

```bash
bb harness plan add <plan-id> "Add export endpoint" \
  --phase worker \
  --deps worker

bb harness plan start <plan-id> "Add export endpoint"
bb harness plan complete <plan-id> "Add export endpoint" \
  --summary "Added endpoint and regression coverage"
```

---

## Agent integration

Harness ships one plugin skill: [`skills/harness-arc/SKILL.md`](skills/harness-arc/SKILL.md).

While a Harness arc is active, the parent thread receives the relevant Harness tools and phase instructions. Ordinary threads receive no Harness tools or instructions.

The native tools are:

```text
harness_get_arc
harness_advance
harness_create_plan
harness_next_node
harness_complete_node
```

The plugin only injects its own `harness-arc` skill. Custom Harness definitions do not grant arbitrary BB skills, tools, filesystem permissions, or shell capabilities.

---

## Lifecycle and safety guarantees

Harness is designed for a local BB installation where a task can remain open while an operator reviews child output.

### Child threads

For a child-execution node, Harness:

1. resolves routing before spawn;
2. atomically claims the node as `starting`;
3. creates a **visible** BB child thread that reuses the parent’s environment;
4. immediately attaches the child ID to the claimed node;
5. records its attempt metadata;
6. stops the just-created child if attachment cannot be committed.

It does not create a new workspace or elevate `permissionMode`. A child is only started after an explicit node Start action.

### Concurrency and cleanup

Start, Stop, and Skip for a parent thread are serialized. The plugin also uses conditional database updates for child attachment and failed-child reconciliation.

This protects against cases such as:

- two Start requests for the same node;
- Stop racing Start;
- Skip racing a child spawn;
- a failed child event arriving after a node was stopped or completed;
- a detached plan being newer than the actual active plan;
- old pre-v2 data containing ambiguous active child records.

On a normal Stop, attached live children are stopped before the plan state becomes terminal. If a required child stop fails, Harness preserves the active state rather than reporting a misleading successful stop.

### Workspace confinement

Workspace mutations use BB’s `bb.sdk.files` APIs and an environment-derived `rootPath`. The plugin does not directly use shell commands or Node filesystem access to modify the user workspace.

### Trust boundary

Harness is a full-trust, in-process BB plugin running for the local user. Plugin RPC is **not** a multi-tenant authorization boundary against a malicious local plugin or user. It does, however, verify canonical parent thread/project ownership to prevent accidental stale-panel or child-thread plan mutations.

The plugin itself makes no network calls, does not request secrets, and does not run shell commands.

---

## How Harness differs from BB Workflows

Both can orchestrate agents, but they solve different problems.

| Harness | BB Workflows |
| --- | --- |
| Operator-driven and long-lived | Script-driven and automatic |
| Visible child threads | Usually hidden workflow workers/progress UI |
| Human review between nodes | Automatic progression from script results |
| Durable interactive DAG and Critic decisions | Deterministic fan-out, fan-in, loops, and structured worker pipelines |
| One task can pause for hours/days | A workflow run is normally started to execute a defined script |

Harness intentionally uses direct child threads so the operator can enter a Worker/Critic/Promote conversation, inspect it, and decide the next transition. A future automation layer could use BB Workflows for batch operations, but Standard Harness is intentionally interactive.

---

## Development

Requirements:

- Node.js compatible with the package dependencies;
- BB `>=0.40`;
- BB Plugin SDK `>=0.4.21`.

```bash
git clone https://github.com/lutfikeskin/bb-plugin-harness.git
cd bb-plugin-harness
npm install

npm test
npm run typecheck
bb plugin types --check .
bb plugin build .
```

During local development:

```bash
bb plugin dev .
```

Or rebuild and reload manually:

```bash
bb plugin build .
bb plugin reload harness
```

The test suite covers definition parsing and snapshots, UI activation, DAG dependency/cycle validation, lifecycle concurrency, child cleanup, Critic decisions, artifact validation, telemetry parsing, migration behavior, and custom policy defaults.

---

## Enable, disable, remove, and update

```bash
bb plugin disable harness   # unload code; retain plugin data
bb plugin enable harness    # load it again
bb plugin reload harness    # reload a local-path install after edits
bb plugin remove harness    # unregister and delete Harness plugin data
```

A local path install stays tied to that local directory. To consume tagged public releases and receive compatible updates, install from the Git semver range:

```bash
bb plugin install git:https://github.com/lutfikeskin/bb-plugin-harness.git@^0.1.1
```

Removing a plugin deletes its plugin-scoped SQLite/KV data. The source checkout is not deleted automatically. Workspace files created by `bb harness init` or artifact output are also not removed automatically.

---

## Compatibility and migration

- Existing plugin databases migrate append-only.
- Existing custom Harness v1 definitions are normalized to v2 defaults when loaded.
- Active runs retain their frozen definition snapshot.
- Historical Milestone records are retained only to avoid destructive database migration; Milestone cannot be selected or started.
- Legacy arcs without a recorded plan ID bind conservatively. Ambiguous old live children are settled safely during Stop rather than guessed at.

---

## License

[MIT](LICENSE)
