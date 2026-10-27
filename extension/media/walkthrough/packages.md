# Pick the tool packages

The server groups its tools into packages. Only the enabled packages are
registered, which keeps the tool list short for the model.

Run **ServiceNow MCP: Choose Tool Packages** or edit the
`servicenowMcp.packages` setting. An empty list means the server default, the
`discovery` profile.

## Profiles

| Profile     | Packages                                 |
| ----------- | ---------------------------------------- |
| `discovery` | table, schema, aggregate (default)       |
| `core`      | discovery + attachment (the 2.x default) |
| `reader`    | table, schema, aggregate                 |
| `developer` | reader + scripts, flows, codecheck, docs |
| `all`       | every package (`admin` is an alias)      |

Profiles and single packages can be combined, for example `discovery` plus
`flows` and `docs`.

## Tips

- Start small. Add `scripts`, `flows` or `docs` when you need script
  intelligence, flow explanations or instance documentation.
- Opt-in packages such as `revert`, `artifacts`, `updatesets`, `ops`, `history`,
  `properties`, `directory` and `ui` are never part of `discovery` or `core`.
- Changing the setting restarts the server definition, and VS Code picks up the
  new tool list.
