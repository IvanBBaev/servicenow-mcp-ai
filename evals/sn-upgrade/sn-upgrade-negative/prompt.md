---
description: A dev-versus-prod comparison is drift, not an upgrade review.
expected_outcome: sn-upgrade does not load, no upgrade review runs, and nothing is written.
tags: [sn-upgrade, negative]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

We're about to promote our work to production. What is different between our dev instance (the default profile) and production (the profile called prod)?
