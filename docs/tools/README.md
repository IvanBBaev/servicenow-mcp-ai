# Tool reference

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

100 tools in 26 packages. Select packages with `SN_TOOL_PACKAGES` (default `core`); the `admin` tools are always on. Setup and settings are in the [README](../../README.md).

| Package | Tools | Read-only | Default `core` |
| ------- | ----: | --------: | :------------: |
| [`table`](table.md) | 6 | 2 | yes |
| [`schema`](schema.md) | 2 | 2 | yes |
| [`aggregate`](aggregate.md) | 1 | 1 | yes |
| [`attachment`](attachment.md) | 5 | 3 | yes |
| [`importset`](importset.md) | 2 | 1 | no |
| [`batch`](batch.md) | 1 | 0 | no |
| [`catalog`](catalog.md) | 5 | 4 | no |
| [`change`](change.md) | 5 | 2 | no |
| [`knowledge`](knowledge.md) | 3 | 3 | no |
| [`cmdb`](cmdb.md) | 7 | 4 | no |
| [`scripts`](scripts.md) | 5 | 5 | no |
| [`flows`](flows.md) | 5 | 5 | no |
| [`codecheck`](codecheck.md) | 3 | 2 | no |
| [`docs`](docs.md) | 9 | 5 | no |
| [`instance`](instance.md) | 3 | 1 | no |
| [`email`](email.md) | 2 | 1 | no |
| [`atf`](atf.md) | 5 | 3 | no |
| [`revert`](revert.md) | 2 | 1 | no |
| [`artifacts`](artifacts.md) | 6 | 5 | no |
| [`updatesets`](updatesets.md) | 3 | 3 | no |
| [`ops`](ops.md) | 2 | 2 | no |
| [`history`](history.md) | 2 | 2 | no |
| [`properties`](properties.md) | 2 | 1 | no |
| [`directory`](directory.md) | 1 | 1 | no |
| [`ui`](ui.md) | 2 | 2 | no |
| [`admin`](admin.md) | 11 | 7 | yes |

## Error codes

A failed call returns `isError: true` with one JSON object: `error` (the message), `code`, `source` (`servicenow`, `policy` or `server`) and, where one helps, `hint` and `detail`.

| Code | Source | Meaning |
| ---- | ------ | ------- |
| `AMBIGUOUS_KEY` | server | An upsert key matches more than one record, or one the user cannot read. |
| `AUTH_EXPIRED` | servicenow | The bearer token (SN_AUTH=token) was rejected with 401 — rotate it. |
| `BUSY` | server | The per-host request queue is full or the wait timed out (SN_MAX_QUEUE / SN_QUEUE_TIMEOUT_MS). |
| `CANCELLED` | server | The client cancelled the tool call; nothing further was sent. |
| `CHILD_NOT_WRITABLE` | server | The child table is not a writable child of the artefact type. |
| `CHILD_PARENT_INVALID` | server | A nested child names no valid earlier parent. |
| `CIRCUIT_OPEN` | server | The per-host circuit breaker is open after consecutive failures. |
| `CONFIRM_DECLINED` | policy | The user declined (or could not answer) the destructive-apply confirmation. |
| `CONFIRM_REQUIRED` | policy | A destructive apply on a prod profile from a client that cannot confirm it. |
| `CONFLICT` | server | The call conflicts with the current state. |
| `CREDENTIALS_INCOMPLETE` | policy | The credential change would leave a profile that cannot authenticate; nothing was saved. |
| `CREDENTIALS_UNCONFIRMED` | policy | The user did not confirm the credential change; nothing was saved. |
| `DEADLINE_EXCEEDED` | server | The per-call deadline (SN_DEADLINE_MS) elapsed across attempts. |
| `DOC_GENERATED` | server | A docs-store write would cross the generated / hand-written line. |
| `DUPLICATE_CHILD_KEY` | server | Two children of one call share a key. |
| `DUPLICATE_UNIQUE_FIELD` | server | An instance-wide unique field value already exists or repeats in the plan. |
| `ELEVATION_REQUIRED` | servicenow | A write to a table that needs an elevated role (security_admin) was refused with 403 — elevate in the UI or deliver it in an update set. |
| `FIELD_NOT_ALLOWED` | policy | A field outside the artefact type's write allow-list. |
| `FLOW_ACTIVE_ONLY` | server | An existing flow accepts only {active}. |
| `INSTANCE_HTML_RESPONSE` | servicenow | The instance answered with an HTML page (hibernating PDI, login page) instead of JSON. |
| `INSTANCE_HTTP_<status>` | servicenow | INSTANCE_HTTP_<status>: the instance answered with that non-2xx status and no more specific code applies; `detail` carries its error body. |
| `INTERNAL_ERROR` | server | An unexpected server-side failure. |
| `INVALID_INPUT` | server | The arguments are invalid; nothing was sent. |
| `MIME_NOT_ALLOWED` | policy | An upload content type is not listed in SN_UPLOAD_MIME_ALLOW. |
| `NO_PACKAGE_SESSION` | server | The client session cannot change its package set. |
| `NOT_CONFIGURED` | server | The profile lacks what its auth method needs; the hint names the missing fields. |
| `NOT_FOUND` | server | The named record, file or object does not exist. |
| `NOT_REVERTIBLE` | server | A write-journal entry cannot be reverted. |
| `NOT_WRITABLE_TYPE` | server | servicenow_upsert_artifact refuses this artefact type. |
| `PACKAGE_ALWAYS_ON` | server | The package is always on and cannot be disabled. |
| `PACKAGE_DENIED` | policy | The package is denied by SN_PACKAGES_DENY. |
| `PAYLOAD_TOO_LARGE` | server | A local payload (upload, document) exceeded its size cap. |
| `PLAN_EXPIRED` | policy | The plan_token's preview expired; preview again and apply with the new token. |
| `PLAN_ONLY_FIELD` | policy | The plan writes a field the registry marks writable:false; the apply is refused. |
| `PLAN_REQUIRED` | policy | A destructive apply needs the plan_token of a matching plan preview; nothing was sent. |
| `POLICY_DENIED` | policy | The table, package or read-only policy refused the call; the hint names the setting. |
| `PREFLIGHT_INVALID` | server | An SDK pre-flight rule refuses a value. |
| `PROPERTY_NOT_FOUND` | server | The named system property does not exist or is not readable. |
| `RECIPIENT_NOT_ALLOWED` | policy | An email recipient is outside SN_EMAIL_ALLOWED_DOMAINS or the instance's own directory. |
| `REDIRECT_BLOCKED` | servicenow | The instance answered with a 3xx redirect; redirects are never followed. |
| `REQUEST_FAILED` | server | A request was refused for a reason no other code names. |
| `RESERVED_PROFILE_NAME` | server | The profile name is reserved (a servicenow:// resource segment); rename the profile. |
| `RESPONSE_TOO_LARGE` | server | A response body exceeded SN_MAX_BODY_BYTES. |
| `SDK_MANAGED_SCOPE` | policy | SN_SDK_MANAGED_WRITES=deny and the record belongs to an SDK-managed scope. |
| `STALE_RECORD` | server | The record changed after the journaled write or the plan; force:true overrides. |
| `TASKS_UNAVAILABLE` | server | MCP tasks are unavailable for this call (SN_EXPERIMENTAL_TASKS). |
| `TIMEOUT` | server | A request attempt timed out (SN_TIMEOUT_MS) and retries were exhausted. |
| `TOO_MANY_CHILDREN` | server | More children on one table than the diff reads. |
| `UNEXPECTED_RESPONSE` | servicenow | The instance answered 2xx with a body that is not the expected API shape. |
| `UNKNOWN_PACKAGE` | server | The name is not a known tool package. |
| `UNKNOWN_PROFILE` | server | The profile argument names no configured connection profile. |
| `UNREACHABLE` | server | The instance could not be reached (DNS, TLS, connection refused). |
| `UNREADABLE` | server | A local file the server needs (key, certificate, secret file) cannot be read. |
| `UPDATE_SET_NOT_FOUND` | server | The named update set does not exist or is not readable. |
| `UPDATE_SET_NOT_IN_PROGRESS` | server | A write was bound to an update set that is not in progress. |
| `UPSTREAM_HTML` | servicenow | The error body was an HTML page (proxy, WAF, SSO) rather than an API body. |
| `WATCH_LIMIT` | server | A record-watch subscription would exceed SN_RECORD_WATCH_MAX_PER_SESSION or SN_RECORD_WATCH_MAX. |
| `WRITE_CAP` | policy | A session or batch write cap would be exceeded; nothing was sent. |
