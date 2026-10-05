---
description: A request to review a UI Builder workspace page before changing it must load sn-uib.
expected_outcome: sn-uib loads, the agent runs servicenow_explain_ui_experience on acme/vendor and names the Vendor record page.
tags: [sn-uib, trigger]
plugins: ["../../.."]
max_turns: 20
allowed_tools: [Skill, Read, Glob, Grep]
---

We want to rework the record page of our Vendor Workspace UI Builder experience (path acme/vendor) on the dev instance. Before we touch it, review the page: how it is built, what depends on it, and whether its data brokers are safe.
