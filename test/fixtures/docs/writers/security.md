# Security review — profile `default`

Generated from the security scan of servicenow_check_code_health (S-3; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.

- **Scan available:** yes
- **Active ACLs scanned:** 5
- **Findings:** 9 (error 1, warn 3, info 5)

## Purpose

<!-- sn:manual:start purpose -->
<!-- sn:manual:end -->

## ACL matrix

Roles each flagged ACL requires, per table and operation (`public` = no role). Only ACLs the scan flagged are listed — an ACL with a condition or script and roles appears only when a rule flagged it.

| Table | create | read | write | delete |
| --- | --- | --- | --- | --- |
| `x_acme_request` | public | itil | public |  |
| `x_acme_step` |  |  |  | security_admin |

## Checks

### ACL scripts

| Severity | Rule | Name | Operation | Roles | Hint |
| --- | --- | --- | --- | --- | --- |
| error | eval-in-acl | `x_acme_step` | read |  | eval() in an ACL evaluation script is a security risk — an attacker-influenced value could flip the access decision. |

### `acl_roles`

Scanned 3 row(s), 6 finding(s).

| Severity | Rule | Name | Operation | Roles | Hint |
| --- | --- | --- | --- | --- | --- |
| info | acl-roles-only | `x_acme_request` | read | itil | Active ACL with no condition and no script — access depends entirely on its assigned roles; confirm a role is set (an empty role list grants everyone). |
| info | acl-roles-only | `x_acme_request` | write |  | Active ACL with no condition and no script — access depends entirely on its assigned roles; confirm a role is set (an empty role list grants everyone). |
| warn | acl-open | `x_acme_request` | write |  | Active ACL with no role, no condition and no script — it grants this operation to every authenticated user. |
| info | acl-roles-only | `x_acme_request` | create | public | Active ACL with no condition and no script — access depends entirely on its assigned roles; confirm a role is set (an empty role list grants everyone). |
| warn | acl-public-role | `x_acme_request` | create | public | ACL grants the 'public' role — anyone, including unauthenticated users, satisfies the role check; confirm the condition/script narrows it. |
| info | acl-roles-only | `x_acme_step.u_request` | delete | security_admin | Active ACL with no condition and no script — access depends entirely on its assigned roles; confirm a role is set (an empty role list grants everyone). |

### `role_inheritance`

Scanned 0 row(s), 0 finding(s).

_None._

### `public_rest_resources`

Scanned 0 row(s), 0 finding(s).

_None._

### `public_ui_pages`

Scanned 0 row(s), 0 finding(s).

_None._

### `tables_without_acl`

Scanned 3 row(s), 1 finding(s).

| Severity | Rule | Name | Operation | Roles | Hint |
| --- | --- | --- | --- | --- | --- |
| warn | table-no-acl | `u_orphan` |  |  | Custom table with no record ACL of its own or on a parent table — add table ACLs. |

### `admin_overlap_roles`

Scanned 0 row(s), 0 finding(s).

_None._

### `elevated_privilege_acls`

Scanned 5 row(s), 1 finding(s).

| Severity | Rule | Name | Operation | Roles | Hint |
| --- | --- | --- | --- | --- | --- |
| info | acl-elevated-privilege | `x_acme_step.u_request` | delete | security_admin | ACL requires the elevated role 'security_admin' — only users who elevate their session pass it; confirm the operation needs it. |

### `ux_data_brokers`

Scanned 0 row(s), 0 finding(s).

_None._

## Hardening

Rule table v1: 0 pass, 0 fail (high 0, medium 0, low 0), 18 not set, 0 unreadable.

| Property | Status | Severity | Expected | Value | Rationale |
| --- | --- | --- | --- | --- | --- |
| `glide.security.use_csrf_token` | not_set | high | true | (no row; default true) | Requires an anti-CSRF token on state-changing UI requests. |
| `glide.sm.default_mode` | not_set | high | deny | (no row; default deny) | With no matching ACL the security manager denies access instead of allowing it. |
| `glide.script.use.sandbox` | not_set | high | true | (no row; default true) | Runs client-supplied scripts (filters, ranges) in the restricted script sandbox. |
| `glide.stax.allow_entity_resolution` | not_set | high | false | (no row; default false) | Blocks XML external entity (XXE) resolution in parsed XML. |
| `glide.script.allow.ajaxevaluate` | not_set | high | false | (no row; default unknown) | Stops clients from evaluating arbitrary server-side expressions through AJAXEvaluate. |
| `glide.security.strict_elevate_privilege` | not_set | medium | true | (no row; default unknown) | Elevated-privilege roles grant their access only after the session elevates. |
| `glide.ui.escape_text` | not_set | medium | true | (no row; default true) | Escapes text fields rendered in the UI (stored XSS). |
| `glide.html.escape_script` | not_set | medium | true | (no row; default true) | Escapes script tags in HTML fields (stored XSS). |
| `glide.ui.security.allow_codetags` | not_set | medium | false | (no row; default false) | Disallows [code] tags that render raw HTML in journal fields. |
| `glide.set_x_frame_options` | not_set | medium | true | (no row; default true) | Sends X-Frame-Options so other sites cannot frame the UI (clickjacking). |
| `glide.cookies.http_only` | not_set | medium | true | (no row; default true) | Marks session cookies HttpOnly so page scripts cannot read them. |
| `glide.ui.secure_cookies` | not_set | medium | true | (no row; default unknown) | Marks cookies Secure so they never travel over plain HTTP. |
| `glide.ui.rotate_sessions` | not_set | medium | true | (no row; default unknown) | Issues a new session id at login (session fixation). |
| `glide.security.file.mime_type.validation` | not_set | medium | true | (no row; default unknown) | Checks that an uploaded attachment's content matches its extension. |
| `glide.login.no_blank_password` | not_set | medium | true | (no row; default unknown) | Refuses logins with a blank password. |
| `glide.basicauth.required.scriptedprocessor` | not_set | medium | true | (no row; default true) | Requires authentication for scripted processors. |
| `glide.ui.session_timeout` | not_set | low | ≤ 30 | (no row; default 30) | Ends idle UI sessions within 30 minutes. |
| `glide.ui.forgetme` | not_set | low | true | (no row; default unknown) | Hides the "Remember me" option that keeps a login for days. |

Property names, expected values and defaults are unverified until O-5 (PDI); a property row hidden by its read roles counts as not set.

## Caveats

- Visibility: every read runs as this profile's user. On a domain-separated instance only the records of the user's domain (and its visible parents) are seen, and ACLs can hide definitions, so an absent entry is not proof that none exists.
- Metadata only: built from dictionary, automation and access-control definitions; no business records were read.
