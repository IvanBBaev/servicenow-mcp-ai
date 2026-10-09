/**
 * ServiceNow sys_id checks: exactly 32 hex digits. ServiceNow emits sys_ids in
 * lower case, so `isSysId` is strict; `isSysIdAnyCase` is for the call sites
 * that also accept a caller-typed upper-case id.
 */

const SYS_ID = /^[0-9a-f]{32}$/;
const SYS_ID_ANY_CASE = /^[0-9a-f]{32}$/i;

/** Whether `value` is a lower-case sys_id. */
export function isSysId(value: string): boolean {
  return SYS_ID.test(value);
}

/** Whether `value` is a sys_id in either case. */
export function isSysIdAnyCase(value: string): boolean {
  return SYS_ID_ANY_CASE.test(value);
}
