---
sn_generated: true
sn_generator: servicenow_snapshot_instance
sn_generator_version: 1
sn_kind: snapshot
sn_profile: default
sn_instance: dev00000.service-now.com
sn_generated_at: <generatedAt>
sn_source_hash: sha256:94f57b81d8ea1719f820f802fbb100a4c353f9e08ccc77eefa40acf3d392f35a
---

# Instance snapshot — profile `default`

Written by servicenow_snapshot_instance (the timestamp is in the frontmatter). The file list is in the root index.md and index.json of the docs folder.

Rows are read with this profile's credentials: domain separation and ACLs can hide records, so every list is what this user can see.

## Warnings

- schema: skipped invalid table name "../evil"
- plugins: sys_plugins hit the SN_MAX_RECORDS cap — the list is partial.
- apps: sys_app hit the SN_MAX_RECORDS cap — the list is partial.
- apps: sys_store_app unavailable — ServiceNow API error (403): no access to sys_store_app
- automation: script_include unavailable — ServiceNow API error (403): stats denied
- automation: acl unavailable — ServiceNow API error (403): no access to sys_security_acl
- properties: sys_properties hit the SN_MAX_RECORDS cap — the list is partial.
- choices: sys_choice hit the SN_MAX_RECORDS cap — the list is partial.
- acls: sys_security_acl unavailable — ServiceNow API error (403): no access to sys_security_acl
- notifications: sysevent_email_action hit the SN_MAX_RECORDS cap — the list is partial.
- flows: sys_hub_flow hit the SN_MAX_RECORDS cap — the list is partial.
- catalog: sc_cat_item hit the SN_MAX_RECORDS cap — the list is partial.
- roles: sys_user_role hit the SN_MAX_RECORDS cap — the list is partial.

## Notes

<!-- sn:manual:start -->
<!-- sn:manual:end -->
