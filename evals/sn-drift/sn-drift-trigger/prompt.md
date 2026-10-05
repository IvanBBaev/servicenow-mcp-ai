---
description: A dev-versus-prod comparison before a promotion must load sn-drift.
expected_outcome: sn-drift loads, the agent compares the default and prod profiles with servicenow_compare_instances and reports the table that exists only on dev.
tags: [sn-drift, trigger]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

We're about to promote our work to production. What is different between our dev instance (the default profile) and production (the profile called prod)?
