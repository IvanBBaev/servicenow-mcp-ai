---
# The first delete call is a preview (no apply:true) and comes before the
# first apply.
type: tool_order
before:
  tool: mcp__plugin_servicenow-mcp-ai_servicenow__servicenow_delete_record
  input_match: '^(?!.*"apply"\s*:\s*true)'
after:
  tool: mcp__plugin_servicenow-mcp-ai_servicenow__servicenow_delete_record
  input_match: '"apply"\s*:\s*true'
---
