---
# A read-only question never applies a create.
# Hard ban: the case-local guard mock aborts the run (score 0) on any
# call; this grader names the violation in the report.
type: tool_used
tool: mcp__plugin_servicenow-mcp-ai_servicenow__servicenow_create_record
input_match: '"apply"\s*:\s*true'
min: 0
max: 0
weight: 2
---
