---
description: A question about what the last upgrade left unresolved must load sn-upgrade.
expected_outcome: sn-upgrade loads, the agent runs servicenow_review_upgrade and names the skipped records still to review.
tags: [sn-upgrade, trigger]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

We patched our dev instance last month. Which skipped records from that upgrade are still unresolved, and should we revert, keep or merge them?
