---
sn_generated: true
sn_generator: servicenow_compare_instances
sn_generator_version: 1
sn_kind: compare
sn_profile: default
sn_instance: dev00000.service-now.com
sn_generated_at: <generatedAt>
sn_source_hash: sha256:cb5eabb1c5f5e24c32fc3fed24d8b6b5f79bba807c8930f95fae9dec40214026
---

# Instance comparison — `default` vs `prod`

Generated <generatedAt>. Scripts compared live, matched by sys_id then name.

## Tables

### Only in default (1)

- u_dev_only

## Columns (common tables, differing properties)

| Table | Column | Property | default | prod |
| --- | --- | --- | --- | --- |
| incident | severity | type | integer | string |

## Scripts

| Type | Name | Status |
| --- | --- | --- |
| business_rule | Common BR | different_source |

### business_rule: Common BR

```diff
--- default/Common BR
+++ prod/Common BR
@@ -1,1 +1,1 @@
-new();
+old();
```

## Records (properties, acls)

| Section | Key | Status | Fields |
| --- | --- | --- | --- |
| properties | glide.ui.title | different | value |

## Plugins

- only in default: com.snc.dev Dev@2 [inactive]

## Applications

- only in prod: x_prod Prod App@1.0

## Warnings

- scripts: acl unavailable on "prod" — ServiceNow API error (403): acl denied
- acls: sys_security_acl unavailable on "prod" — ServiceNow API error (403): acl denied
- apps: sys_store_app unavailable on "prod" — ServiceNow API error (403): store denied

## Caveats

- Domain separation: on a domain-separated instance each profile sees only the records of its user's domain (and its visible parents). Domain-specific overrides of scripts and dictionary entries can therefore show up as — or hide — drift. Compare with users in the same domain (or global) for a like-for-like result.
- Visibility: every read runs as the profile's user. ACLs, before-query rules and roles that differ between the two users make records appear 'only in' one side; use equivalent (ideally admin) read access on both instances.
- Matching: scripts and records are matched by sys_id, then by name across all application scopes; two artefacts with the same name in different scopes (and different sys_ids) are compared as one.
