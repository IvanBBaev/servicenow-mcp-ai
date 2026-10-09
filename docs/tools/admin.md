# `admin` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

11 tools (7 read-only, 4 write). Always on. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_set_credentials`](#servicenow_set_credentials) | no | Set ServiceNow credentials |
| [`servicenow_list_instances`](#servicenow_list_instances) | yes | List connection profiles |
| [`servicenow_use_instance`](#servicenow_use_instance) | no | Switch connection profile |
| [`servicenow_explain_policy`](#servicenow_explain_policy) | yes | Explain ServiceNow access policy |
| [`servicenow_get_status`](#servicenow_get_status) | yes | Get ServiceNow connection status |
| [`servicenow_test_connection`](#servicenow_test_connection) | yes | Test ServiceNow connection |
| [`servicenow_check_capabilities`](#servicenow_check_capabilities) | yes | Check achievable capabilities |
| [`servicenow_list_packages`](#servicenow_list_packages) | yes | List tool packages |
| [`servicenow_enable_package`](#servicenow_enable_package) | no | Enable a tool package |
| [`servicenow_disable_package`](#servicenow_disable_package) | no | Disable a tool package |
| [`servicenow_find_tools`](#servicenow_find_tools) | yes | Find tools by intent |

## servicenow_set_credentials

**Set ServiceNow credentials.** Save connection credentials to the env file for later requests (any subset; auth / oauth_client_id / oauth_grant pick the method). Secrets are never arguments: list them in request_secrets for elicitation. See 'instance' for host changes.

**Writes:** Write, idempotent.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `instance` | string | no | Instance host, e.g. 'dev12345'. A change needs the new host's auth in the same call (Basic: user + password, else CREDENTIALS_INCOMPLETE) and elicitation confirmation unless SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1. |
| `user` | string | no | ServiceNow username. |
| `password` | string | no | ServiceNow password. |
| `auth` | "basic" \| "oauth" \| "apikey" \| "token" \| "none" | no | Stored as SN_AUTH (default: inferred). |
| `oauth_client_id` | string | no | OAuth client id (not a secret). |
| `oauth_grant` | "password" \| "client_credentials" \| "refresh_token" \| "jwt_bearer" | no | Stored as SN_OAUTH_GRANT. |
| `request_secrets` | "api_key" \| "oauth_client_secret"[] | no | Secrets to enter through elicitation (never as arguments). |
| `profile` | string | no | Profile (default active); a new name creates one. |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_list_instances

**List connection profiles.** List the connection profiles: name, host, user, auth method (and OAuth grant), refresh-token state, read-only flag, write mode, credentials complete. Secrets are never included.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `count` | number |  |
| `profiles` | any[] |  |

## servicenow_use_instance

**Switch connection profile.** Switch the connection profile (over HTTP: this session only unless persist).

**Writes:** Write, idempotent.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `name` | string | yes | Profile to activate, e.g. 'dev'. |
| `persist` | boolean | no | Write the env file (journaled). Default: stdio yes, HTTP no. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_explain_policy

**Explain ServiceNow access policy.** Say whether a table may be read or written under the active policy and which rule decides, or, without a table, return the effective policy. Local; no instance call.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | no | Table to check. |
| `action` | "read" \| "write" | no | Default read. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_get_status

**Get ServiceNow connection status.** Show instance, auth, missing credentials, per-profile write mode, policy, limits, TLS, queue, write counters, version, uptime. Secrets are never shown.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `configured` | boolean |  |
| `activeProfile` | string |  |
| `profiles` | string[] |  |
| `instance` | string |  |
| `user` | string |  |
| `passwordSet` | boolean |  |
| `authMode` | string |  |
| `authWarnings` | string[] |  |
| `readOnly` | boolean |  |
| `allowedTables` | string[] |  |
| `deniedTables` | string[] |  |
| `enabledPackages` | string[] |  |
| `deniedPackages` | string[] |  |
| `readOnlyPackages` | string[] |  |
| `pluginApis` | record<string> |  |
| `telemetry` | object |  |
| `http` | object |  |
| `sdkManaged` | object |  |
| `server` | object |  |
| `policy` | object |  |
| `writes` | record<any> |  |
| `profileDetails` | object[] |  |

## servicenow_test_connection

**Test ServiceNow connection.** Verify the credentials work: reads one sys_user record, reports ok/status/latency. Auth and connectivity problems come back as ok:false, not errors.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `ok` | boolean |  |
| `status` | number \| null |  |
| `latencyMs` | number |  |
| `user` | string |  |
| `message` | string |  |

## servicenow_check_capabilities

**Check achievable capabilities.** Preflight which sys_* tables are readable and which capabilities work — run it before scripts/flows/codecheck on a governed instance. 'groups' picks matrix probes; results are cached (refresh:true).

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `groups` | "writes" \| "update_sets" \| "attachments" \| "aggregate" \| "import_sets" \| "email" \| "atf" \| "version" \| "roles"[] | no | Groups to probe (default all), one read-only probe each; update_sets adds canRead / canSet (inferred). The sys_* preflight always runs. |
| `refresh` | boolean | no | Discard the cache and probe again. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `degraded` | boolean |  |
| `summary` | string |  |
| `capabilities` | any |  |
| `matrix` | any |  |

## servicenow_list_packages

**List tool packages.** List tool packages with their session state: enabled, configured, denied, read-only, tool count. Toggle one with servicenow_enable_package / servicenow_disable_package.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `packages` | any[] |  |
| `enabled` | string[] |  |

## servicenow_enable_package

**Enable a tool package.** Enable a tool package for this session (list_changed is sent). Denied packages are refused; a read-only package brings only its read tools. Ends with the session.

**Writes:** Write, idempotent.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `name` | string | yes | Package name, e.g. 'codecheck'. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `package` | string |  |
| `enabled` | boolean |  |
| `changed` | boolean |  |
| `readOnly` | boolean |  |
| `tools` | string[] |  |
| `prompts` | string[] |  |

## servicenow_disable_package

**Disable a tool package.** Disable a tool package for this session: its tools, resources and prompts are withdrawn (list_changed is sent). The admin tools cannot be disabled.

**Writes:** Write, idempotent.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `name` | string | yes | Package name, e.g. 'codecheck'. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `package` | string |  |
| `enabled` | boolean |  |
| `changed` | boolean |  |
| `readOnly` | boolean |  |
| `tools` | string[] |  |
| `prompts` | string[] |  |

## servicenow_find_tools

**Find tools by intent.** Search all tool packages, loaded or not, by intent; servicenow_enable_package loads a match's package.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `query` | string | yes | What to do, e.g. 'run an ATF suite'. |
| `limit` | integer | no |  |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `matches` | any[] |  |
