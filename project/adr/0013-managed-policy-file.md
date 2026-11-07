# 0013 — Managed policy file and host environment map (N-108, OD-26)

- **Status:** accepted
- **Date:** 2026-11-07
- **Owner gate / ID:** OD-26 (decided 2026-10-30: (c) file + instance property), role review GV-I1
- **Supersedes:** —
- **Superseded by:** —

## Context

Every policy control (`SN_READONLY`, `SN_TABLES_DENY`, `SN_DESTRUCTIVE_CONFIRM`, the write caps,
`SN_ENV`) is read from the process environment or the user's own env file. The person the policy
restrains — or an agent acting for them — can therefore loosen it, and `prod` is a flag the user
declares about their own profile. An enterprise rollout needs floors set by an administrator.

## Decision

1. **A managed policy file** (JSON) is read from the OS path the user cannot write:
   `/etc/servicenow-mcp-ai/policy.json` (Linux), `/Library/Application Support/servicenow-mcp-ai/policy.json`
   (macOS), `%ProgramData%\servicenow-mcp-ai\policy.json` (Windows). No setting turns it off.
   `SN_MANAGED_POLICY_FILE` adds a second file for containers, where the image owner sets the
   environment; the OS file is applied after it.
2. **Format:** `{ "settings": { <key>: <value> }, "environments": { <host pattern>: "prod" | "test" | "dev" }, "disableWrites": true }`.
   Only the keys below can be locked; each value is validated like the setting itself.
3. **Merge rules** — the user can only tighten:
   - flags (`SN_READONLY`, `SN_REDACT_PII`, `SN_JOURNAL_REQUIRED`): `true` locks on;
   - lists (`SN_TABLES_DENY`, `SN_PACKAGES_DENY`, `SN_PACKAGES_READONLY`, `SN_REDACT_FIELDS`): union;
   - ordered (`SN_WRITE_MODE`, `SN_DESTRUCTIVE_CONFIRM`, `SN_PROTECTED_TABLES_WRITE`,
     `SN_BATCH_UNMAPPED`): the stricter value;
   - caps (`SN_MAX_WRITES_PER_SESSION`, `SN_MAX_DELETES_PER_SESSION`, `SN_MAX_BATCH_WRITES`,
     `SN_BATCH_MAX_REQUESTS`): the lower cap; `0` (no cap) never beats a managed cap;
   - allowlists (`SN_TABLES_ALLOW`, `SN_ALLOWED_HOSTS`, `SN_IMPORT_SET_TABLES`): replaced.
     The rules apply to every profile.
4. **Environment map:** the profile's instance host is matched exactly first, then against the
   first `*` / `?` pattern in file order; a match replaces `SN_ENV`.
5. **Fail closed:** a file that exists but cannot be read or parsed, has an unknown field, names a
   key that cannot be locked or holds an invalid value stops startup with `MANAGED_POLICY_INVALID`.
   A missing file is no policy.
6. The files are read once per process; a change needs a restart.
7. `servicenow_explain_policy` / `servicenow://policy` (`managed`) and `doctor` report the files
   and the locked keys. `get_status` is unchanged (its output schema would cost `tools/list` bytes).
8. **Part 2 (open):** an instance-side system property as a kill switch, read with a TTL; an
   applied write is refused with `POLICY_KILL_SWITCH`.

## Consequences

- Opt-in and not breaking: without a file nothing changes. `tools/list`: +0 B.
- The layer sits in the settings reader (`settings-manifest.ts` → `managed-policy.ts` through a
  registered hook), so every getter, `settingSource` and `explain_policy` see the merged value.
- A user with administrator rights on the machine can still edit the OS file; the control is
  against the restrained user, not the machine owner.
