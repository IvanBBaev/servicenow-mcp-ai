# Security review — profile `default`

Generated from the security scan of servicenow_check_code_health (S-3; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.

- **Scan available:** no
- **Unavailable:** sys_security_acl is not readable for this user (needs the security_admin or admin role). Run servicenow_check_capabilities.
- **Active ACLs scanned:** 0
- **Findings:** 0 (error 0, warn 0, info 0)

## Purpose

<!-- sn:manual:start purpose -->
<!-- sn:manual:end -->

## Caveats

- No access-control data could be read, so this document holds no findings. Re-run with a user that can read sys_security_acl.
- Metadata only: built from dictionary, automation and access-control definitions; no business records were read.
