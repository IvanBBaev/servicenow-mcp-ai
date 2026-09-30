# Run the doctor

**ServiceNow MCP: Run Doctor** runs `servicenow-mcp-ai doctor --json` with the
same launcher, settings and credentials as the server itself. It checks:

- which env file is used and whether it exists,
- whether the credentials are complete,
- whether the instance answers and the user can authenticate,
- which tables and capabilities the user can read.

The verdict appears in a notification and in the **status bar**:

| Icon         | Meaning                                        |
| ------------ | ---------------------------------------------- |
| check        | healthy                                        |
| warning      | degraded — connected, but something is missing |
| circle-slash | not configured — sign in or set an env file    |
| error        | the doctor could not run                       |

Click the status-bar item to run the doctor again. The full report is in the
**ServiceNow MCP** output channel (**ServiceNow MCP: Show Output**).

The first run may take a while: `npx` downloads the server package once.
