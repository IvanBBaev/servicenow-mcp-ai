---
description: A single-record data change is a write, not a drift review.
expected_outcome: sn-drift does not load, no instance comparison runs, nothing is deleted, and the update is not applied before the user approves its preview.
tags: [sn-drift, negative]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

On our dev instance, please set the priority of incident INC0010001 to 2.
