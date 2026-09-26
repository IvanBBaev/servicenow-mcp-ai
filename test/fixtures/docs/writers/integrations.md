# Integrations — profile `default`

Generated from the integration definitions (sys_ws_definition, sys_rest_message, sys_transform_map, sys_data_source; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.

- **Scripted REST APIs:** 1
- **Outbound REST messages:** 1
- **Transform maps:** 0
- **Data sources:** 1

## Purpose

<!-- sn:manual:start purpose -->
<!-- sn:manual:end -->

## Inbound — scripted REST APIs

| Name | Namespace | Base URI | Active | Scope |
| --- | --- | --- | --- | --- |
| Acme Orders | `x_acme` | `/api/x_acme/orders` | yes | `x_acme` |

## Outbound — REST messages

| Name | Endpoint | Authentication | Scope |
| --- | --- | --- | --- |
| Weather | `https://api.example.com/weather` | no_authentication | `global` |

## Import — transform maps

_Not readable for this user — see Caveats._

## Import — data sources

| Name | Type | Import set table | Format | Scope |
| --- | --- | --- | --- | --- |
| HR feed | File | `u_hr_import` | CSV | `global` |

## Caveats

- `sys_transform_map` is not readable for this user; its section is empty.
- Descriptive fields only: credentials, connection strings and scripts of these definitions are not read.
- Visibility: every read runs as this profile's user. On a domain-separated instance only the records of the user's domain (and its visible parents) are seen, and ACLs can hide definitions, so an absent entry is not proof that none exists.
- Metadata only: built from dictionary, automation and access-control definitions; no business records were read.
