---
description: A question about why one user cannot delete records must load sn-security.
expected_outcome: sn-security loads, the agent runs servicenow_explain_access for beth.anglin, incident and delete, and names the admin-only ACL that denies it.
tags: [sn-security, trigger]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

On our dev instance, beth.anglin says she cannot delete incidents. Why not — which rule stops her?
