# Security review — profile `default`

Generated from the security scan of servicenow_check_code_health (S-3; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.

- **Scan available:** no
- **Unavailable:** sys_security_acl is not readable for this user (needs the security_admin or admin role). Run servicenow_check_capabilities.
- **Active ACLs scanned:** 0
- **Findings:** 0 (error 0, warn 0, info 0)

## Purpose

<!-- sn:manual:start purpose -->
<!-- sn:manual:end -->

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

- No access-control data could be read, so this document holds no findings. Re-run with a user that can read sys_security_acl.
- Metadata only: built from dictionary, automation and access-control definitions; no business records were read.
