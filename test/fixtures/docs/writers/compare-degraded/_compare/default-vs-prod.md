---
sn_generated: true
sn_generator: servicenow_compare_instances
sn_generator_version: 1
sn_kind: compare
sn_profile: default
sn_instance: dev00000.service-now.com
sn_generated_at: <generatedAt>
sn_source_hash: sha256:8983eea02da95b3c4771d08f15f0c9688563911882e749f3ccc994411b4572fd
---

# Instance comparison — `default` vs `prod`

Generated <generatedAt>. Scripts compared live, matched by sys_id then name.

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

- only in default: com.snc.base Base@1

## Applications

- only in prod: x_prod Prod App@1.0

## Warnings

- columns: sys_dictionary on "default" hit the SN_MAX_RECORDS cap — the column diff is partial (raise SN_MAX_RECORDS for a complete comparison).
- columns: sys_dictionary on "prod" hit the SN_MAX_RECORDS cap — the column diff is partial (raise SN_MAX_RECORDS for a complete comparison).
- scripts: business_rule on "default" hit the SN_MAX_RECORDS cap — the script diff is partial.
- scripts: acl on "default" hit the SN_MAX_RECORDS cap — the script diff is partial.
- scripts: dictionary_script on "default" hit the SN_MAX_RECORDS cap — the script diff is partial.
- scripts: business_rule on "prod" hit the SN_MAX_RECORDS cap — the script diff is partial.
- scripts: acl unavailable on "prod" — ServiceNow API error (403): acl denied
- scripts: dictionary_script on "prod" hit the SN_MAX_RECORDS cap — the script diff is partial.
- roles: sys_user_role hit the SN_MAX_RECORDS cap — the list is partial. (default)
- roles: sys_user_role hit the SN_MAX_RECORDS cap — the list is partial. (prod)
- plugins: v_plugin on "default" hit the SN_MAX_RECORDS cap — the plugin diff is partial.
- plugins: unavailable on "prod" — ServiceNow API error (403): plugins denied
- apps: sys_app on "prod" hit the SN_MAX_RECORDS cap — the app diff is partial.
- apps: sys_store_app unavailable on "prod" — ServiceNow API error (403): store denied

## Caveats

- Domain separation: on a domain-separated instance each profile sees only the records of its user's domain (and its visible parents). Domain-specific overrides of scripts and dictionary entries can therefore show up as — or hide — drift. Compare with users in the same domain (or global) for a like-for-like result.
- Visibility: every read runs as the profile's user. ACLs, before-query rules and roles that differ between the two users make records appear 'only in' one side; use equivalent (ideally admin) read access on both instances.
- Matching: scripts and records are matched by sys_id, then by name across all application scopes; two artefacts with the same name in different scopes (and different sys_ids) are compared as one.
