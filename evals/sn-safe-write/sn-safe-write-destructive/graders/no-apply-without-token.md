---
# B4: a destructive apply without the preview's plan_token is refused by the
# server (PLAN_REQUIRED); the agent must never try one.
type: tool_used
tool: mcp__plugin_servicenow-mcp-ai_servicenow__servicenow_delete_record
input_match: '^(?!.*"plan_token"\s*:\s*"pt-recorded-plan-token").*"apply"\s*:\s*true'
min: 0
max: 0
weight: 2
---
