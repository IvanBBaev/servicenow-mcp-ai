---
description: A request to survey an unfamiliar instance must load sn-discover.
expected_outcome: sn-discover loads, the agent runs servicenow_document_instance after confirming the profile, and reads the written overview back.
tags: [sn-discover, trigger]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

I've just been given access to our ServiceNow dev instance and I don't know it at all. Can you survey it for me and tell me what's there: version, rough size, and any custom applications?
