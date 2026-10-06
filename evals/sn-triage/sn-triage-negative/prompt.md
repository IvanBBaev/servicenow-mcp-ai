---
description: A request to survey an instance is discovery, not triage.
expected_outcome: sn-triage does not load, the operational logs are not read, and no write tool is called.
tags: [sn-triage, negative]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

I've just been given access to our ServiceNow dev instance and I don't know it at all. Can you survey it for me and tell me what's there: version, rough size, and any custom applications?
