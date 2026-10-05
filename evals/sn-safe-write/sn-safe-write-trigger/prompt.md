---
description: A data change request must load sn-safe-write and stop at the plan.
expected_outcome: sn-safe-write loads, the agent previews the update without apply and asks for approval instead of applying it.
tags: [sn-safe-write, trigger]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

On our dev instance, please set the priority of incident INC0010001 to 2.
