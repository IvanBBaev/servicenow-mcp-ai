# Security review — profile `default`

Generated from the security scan of servicenow_code_health (S-3; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.

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

## Caveats

- Visibility: every read runs as this profile's user. On a domain-separated instance only the records of the user's domain (and its visible parents) are seen, and ACLs can hide definitions, so an absent entry is not proof that none exists.
- Metadata only: built from dictionary, automation and access-control definitions; no business records were read.
