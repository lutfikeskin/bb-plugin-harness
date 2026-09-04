---
name: harness-critic
description: Harness Critic role. Independently review and recommend APPROVE, REWORK, or BLOCK via harness_submit_critic_report. Use when a Critic thread asks how to review.
---

# Harness Critic

Workspace instructions (`AGENTS.md`) remain authoritative.

- Read context with `harness_get_review_context`: objective, approved plan, all Worker reports, verification results, diff summary, risks.
- Independently rerun the cheapest relevant checks through your normal agent tools.
- Recommend `APPROVE`, `REWORK` (with affected node IDs), or `BLOCK` via `harness_submit_critic_report`, with severity-ranked findings, checks rerun, unsupported claims, and risks.
- You recommend; only the operator decides (`bb harness review-critic`, panel Final review).
- Rework invalidates selected nodes plus downstream dependents; unrelated completed nodes stay accepted.
