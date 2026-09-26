---
sn_generated: true
sn_generator: servicenow_document_instance
sn_generator_version: 1
sn_kind: discovery_tables
sn_profile: default
sn_instance: dev00000.service-now.com
sn_generated_at: <masked>
sn_source_hash: <masked>
---

# Discovery: tables of `x_acme` — profile `default`

Tables the scope owns (`sys_db_object`) and their own columns (`sys_dictionary`); inherited columns live on the parent table. [Overview](overview.md) · [Applications](apps.md)

## Tables

| Table | Label | Extends | Columns |
| --- | --- | --- | --- |
| `x_acme_request` | Request | `task` | 1 |
| `x_acme_step` | Step |  | 1 |

## `x_acme_request`

| Column | Label | Type | Reference | Max length | Mandatory |
| --- | --- | --- | --- | --- | --- |
| `u_owner` |  | `reference` | `sys_user` |  |  |

## `x_acme_step`

| Column | Label | Type | Reference | Max length | Mandatory |
| --- | --- | --- | --- | --- | --- |
| `u_request` |  | `reference` | `x_acme_request` |  |  |

## Caveats

- Discovery files are thin renderings of the same data the other documents of this profile use; re-run with the same depth to refresh them.
- Visibility: every read runs as this profile's user. On a domain-separated instance only the records of the user's domain (and its visible parents) are seen, and ACLs can hide definitions, so an absent entry is not proof that none exists.
- Metadata only: built from dictionary, automation and access-control definitions; no business records were read.
