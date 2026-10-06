---
# The apply reuses the plan_token of the preview (single use: exactly once).
type: tool_used
tool: mcp__plugin_servicenow-mcp-ai_servicenow__servicenow_delete_record
input_match: '^(?=.*"apply"\s*:\s*true)(?=.*"plan_token"\s*:\s*"pt-recorded-plan-token")'
min: 1
max: 1
weight: 2
---
