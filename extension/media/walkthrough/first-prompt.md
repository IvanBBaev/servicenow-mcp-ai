# Try a first prompt

**ServiceNow MCP: Try a First Prompt** opens Copilot Chat in **agent mode** with
a read-only question ready to send. Review it, then press Enter.

Make sure the **ServiceNow MCP** server is enabled in the chat's tool picker.

## More ideas

- "Describe the `incident` table and its most important fields."
- "Count open incidents by priority."
- "Which business rules run when an incident is updated?" (needs `scripts`)
- "Explain the flow that handles new catalog requests." (needs `flows`)
- "Document the `x_acme_app` application." (needs `docs`)

Write tools (create, update, delete) run in plan mode by default
(`SN_WRITE_MODE=plan`): they preview the change as a before/after diff and
change nothing until the call is repeated with `apply: true`.
