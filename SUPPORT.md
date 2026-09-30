# Getting help

`servicenow-mcp-ai` is maintained by one person in their own time. Support is
best-effort through GitHub; there is no commercial support and no response-time
commitment for questions or bugs (security reports have
[their own targets](SECURITY.md#response-targets)).

## Where to go

| You want to…                             | Go to                                                                                                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set it up or configure it                | The [README](README.md) — [Setup](README.md#setup), [Configure credentials](README.md#configure-credentials), [Environment variables](README.md#environment-variables)             |
| Check that your setup works              | `servicenow-mcp-ai doctor` ([Verify your setup](README.md#verify-your-setup))                                                                                                      |
| Report a bug                             | [New issue → Bug report](https://github.com/IvanBBaev/servicenow-mcp-ai/issues/new/choose) — search [existing issues](https://github.com/IvanBBaev/servicenow-mcp-ai/issues) first |
| Suggest a feature or a new tool          | [New issue → Feature request](https://github.com/IvanBBaev/servicenow-mcp-ai/issues/new/choose)                                                                                    |
| Report a vulnerability                   | **Privately**, as described in [SECURITY.md](SECURITY.md) — never in a public issue                                                                                                |
| Contribute a change                      | [CONTRIBUTING.md](CONTRIBUTING.md)                                                                                                                                                 |
| Ask about the ServiceNow platform itself | ServiceNow's own documentation, support and community — this project does not cover the platform                                                                                   |

## What to include in a bug report

The bug form asks for the version, the MCP client and the transport, plus the
output of `doctor --json`. Two CLI commands produce what is needed:

```bash
# Health check as JSON: env file, checks, configuration, connection,
# capabilities and the server status. Paste it into the bug form.
npx servicenow-mcp-ai doctor --json

# A full support bundle: the doctor JSON, the effective SN_* settings with
# secrets masked, npm ls, the tool manifest summary and the last 200 lines
# of SN_LOG_FILE (when set). Prints the path of the file it wrote.
npx servicenow-mcp-ai support-bundle --out support-bundle.json
```

Add `--profile <name>` to either command to check a named profile. With a
global install, drop the `npx`. Attach the bundle only when asked for it or
when the doctor output is not enough.

## What not to paste

Issues are public. **Review everything before you post it.**

- **Secrets** — passwords, API keys, OAuth client secrets, refresh or bearer
  tokens (`SN_HTTP_TOKEN`), private keys, cookies, and the contents of your env
  file. `support-bundle` masks the values of secret settings as `***` and
  scrubs them from the rest of the file, but a secret stored under an unusual
  name or pasted into a tool argument can still slip through.
- **Personal data** — names, email addresses, phone numbers and other PII from
  instance records. Trim tool results to the fields that show the problem.
- **Identifying details you do not want public** — the doctor output contains
  your instance host name, user name and local file paths. Replace them with
  placeholders (`your-instance.service-now.com`) if they are sensitive; keep
  the structure intact.
- **Customer or production data** — reproduce on a personal developer instance
  (PDI) where you can.

If you posted a secret by mistake, rotate it on the instance first, then edit
or delete the comment.
