---
description: A question about what depends on a field before changing it must load sn-impact.
expected_outcome: sn-impact loads, the agent runs servicenow_where_used on incident.priority and names the report or business rule that relies on it.
tags: [sn-impact, trigger]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

I'm planning to change how the priority field on the incident table works on our dev instance. Before I touch it, what depends on incident.priority and what automation runs around it?
