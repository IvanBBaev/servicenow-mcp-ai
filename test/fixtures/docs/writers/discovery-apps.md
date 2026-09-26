---
sn_generated: true
sn_generator: servicenow_document_instance
sn_generator_version: 1
sn_kind: discovery_apps
sn_profile: default
sn_instance: dev00000.service-now.com
sn_generated_at: <masked>
sn_source_hash: <masked>
---

# Discovery: applications — profile `default`

The custom applications (`sys_app`, global excluded), with what discovery found in each. [Overview](overview.md)

| Name | Scope | Version | Active | Source | Tables | Artefacts | Files |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Acme Requests | `x_acme` | 1.2.0 | yes | `sys_app` | 2 | 21 | [tables](tables-x_acme.md) · [artefacts](artifacts-x_acme.md) |

## Caveats

- `n/a` means that scope's file was not built in this run (it failed; see the tool result's `failed`).
- Discovery files are thin renderings of the same data the other documents of this profile use; re-run with the same depth to refresh them.
- Visibility: every read runs as this profile's user. On a domain-separated instance only the records of the user's domain (and its visible parents) are seen, and ACLs can hide definitions, so an absent entry is not proof that none exists.
- Metadata only: built from dictionary, automation and access-control definitions; no business records were read.
