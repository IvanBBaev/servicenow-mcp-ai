---
sn_generated: true
sn_generator: servicenow_compare_instances
sn_generator_version: 1
sn_kind: compare
sn_profile: default
sn_instance: dev00000.service-now.com
sn_generated_at: <generatedAt>
sn_source_hash: sha256:e6b13719e60df4abc951f20592aa30035e7f82095e2627c0e4b00d61079809fb
---

# Instance comparison — `default` vs `prod`

Generated <generatedAt> (tables/plugins/apps from snapshots where available). Scripts compared live, matched by sys_id then name.

## Tables

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

## Records (roles)

No differences.

## Plugins

- only in default: com.snc.cmdb CMDB@2.0 [inactive]
- only in default: com.snc.incident Incident@1.0
- only in prod: com.snc.base Base@1

## Applications

- only in default: sn_store Store@3
- only in default: x_hr HR App@2.1
- only in default: x_old Old App@0.9 [inactive]
- only in prod: x_prod Prod App@1.0

## Warnings

- tables: no snapshot for "prod", reading live
- scripts: acl unavailable on "prod" — ServiceNow API error (403): acl denied
- roles: no snapshot for "prod", reading live
- inventory: no snapshot for "prod", reading live
- apps: sys_store_app unavailable on "prod" — ServiceNow API error (403): store denied

## Caveats

- Domain separation: on a domain-separated instance each profile sees only the records of its user's domain (and its visible parents). Domain-specific overrides of scripts and dictionary entries can therefore show up as — or hide — drift. Compare with users in the same domain (or global) for a like-for-like result.
- Visibility: every read runs as the profile's user. ACLs, before-query rules and roles that differ between the two users make records appear 'only in' one side; use equivalent (ideally admin) read access on both instances.
- Matching: scripts and records are matched by sys_id, then by name across all application scopes; two artefacts with the same name in different scopes (and different sys_ids) are compared as one.
