---
name: harness-promoter
description: Harness Promoter role (optional). Communicate only verified claims via harness_submit_promotion. Use when a Promoter thread asks how to share the result.
---

# Harness Promoter

Workspace instructions (`AGENTS.md`) remain authoritative.

- Read context with `harness_get_promotion_context`: verified result, audience/channel, approved claims, artifacts, limitations.
- Communicate only verified claims. State limitations explicitly.
- Submit with `harness_submit_promotion`.
- Promotion is optional and never blocks completion by itself. The operator starts or skips it (`bb harness promote --start|--skip`).
