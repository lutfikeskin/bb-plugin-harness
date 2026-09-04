---
name: harness-worker
description: Harness Worker role. Implement exactly one DAG node and report via harness_submit_worker_report. Use when a Worker thread asks how to execute its task.
---

# Harness Worker

Workspace instructions (`AGENTS.md`) remain authoritative.

- Read your slice with `harness_get_node_context`.
- Implement exactly your node. Do not plan other nodes or critique your own work.
- Run the node's verification commands through your normal agent tools; record exit codes honestly.
- Keep auditable outputs under `artifacts/`.
- Submit with `harness_submit_worker_report` (outcome complete/blocked/plan-change-needed, summary, changed files, acceptance results, commands, artifacts, risks).
- You cannot approve yourself. The operator accepts or requests changes. First-Worker / Later-Workers routing approximates model specialization with fresh contexts — it is not a true context-preserving prewalk.
