import { snRequest } from "../core/http.js";
import { assertWriteAllowed, assertTableAllowed } from "../core/policy.js";
import { ServiceNowError } from "../core/errors.js";
import { getEmailAllowedDomains } from "../core/settings.js";
import { logger } from "../core/logging.js";
import { EMAIL_ADDRESS_RE, expectResult } from "./shared.js";
import { pluginCall } from "./plugin.js";

/**
 * ServiceNow Email API (`/api/now/email`). Wrapped in pluginCall because the
 * API requires an activated plugin on some instances.
 */

export interface SendEmailArgs {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  /** Optional record to associate the email with. */
  table?: string;
  sysId?: string;
}

const RECIPIENT_HINT =
  "Set SN_EMAIL_ALLOWED_DOMAINS to the recipient domains this server may email (a domain covers its subdomains; * allows any).";

function recipientError(message: string): ServiceNowError {
  return new ServiceNowError(message, 403, undefined, {
    code: "RECIPIENT_NOT_ALLOWED",
    hint: RECIPIENT_HINT,
  });
}

/** True when `address`'s domain is an allow-listed domain or a subdomain of one. */
function domainAllowed(address: string, domains: string[]): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * The emails, among `addresses`, that belong to a user of the instance. One
 * sys_user query; the addresses are validated first, so they cannot carry an
 * encoded-query separator.
 */
async function directoryEmails(addresses: string[]): Promise<Set<string>> {
  const params = new URLSearchParams({
    sysparm_query: `emailIN${addresses.join(",")}`,
    sysparm_fields: "email",
    sysparm_limit: String(Math.max(100, addresses.length * 4)),
  });
  const { data } = await snRequest<{ result?: { email?: unknown }[] }>({
    method: "GET",
    path: "/api/now/table/sys_user",
    params,
  });
  const rows = Array.isArray(data?.result) ? data.result : [];
  return new Set(
    rows
      .map((r) => (typeof r.email === "string" ? r.email.toLowerCase() : ""))
      .filter(Boolean),
  );
}

/**
 * Exfiltration guard for send_email (H-6 / SEC-14). Every to/cc/bcc address
 * must be a well-formed single address and either match
 * SN_EMAIL_ALLOWED_DOMAINS (`*` = any) or, when that is unset, be the email of
 * a user in the instance's own directory. A failed directory lookup fails
 * closed. Throws RECIPIENT_NOT_ALLOWED naming the refused addresses.
 */
export async function assertRecipientsAllowed(
  addresses: string[],
): Promise<void> {
  const all = [...new Set(addresses.map((a) => a.trim().toLowerCase()))];
  const malformed = all.filter((a) => !EMAIL_ADDRESS_RE.test(a));
  if (malformed.length > 0) {
    throw new ServiceNowError(
      `Not a single email address: ${malformed.join(", ")}.`,
      400,
    );
  }
  const domains = getEmailAllowedDomains();
  if (domains.includes("*")) return;
  if (domains.length > 0) {
    const denied = all.filter((a) => !domainAllowed(a, domains));
    if (denied.length > 0) {
      throw recipientError(
        `Recipient(s) outside SN_EMAIL_ALLOWED_DOMAINS: ${denied.join(", ")}.`,
      );
    }
    return;
  }
  let known: Set<string>;
  try {
    known = await directoryEmails(all);
  } catch (e) {
    logger.warn("send_email recipient directory lookup failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    throw recipientError(
      "Could not verify the recipients against the instance's user directory (sys_user), so the email was not sent.",
    );
  }
  const denied = all.filter((a) => !known.has(a));
  if (denied.length > 0) {
    throw recipientError(
      `Recipient(s) are not users of this instance: ${denied.join(", ")}. Without SN_EMAIL_ALLOWED_DOMAINS only sys_user emails may be addressed.`,
    );
  }
}

export async function sendEmail(args: SendEmailArgs): Promise<unknown> {
  // H-4: an email is a sys_email row, optionally tied to a record's table.
  assertTableAllowed("sys_email");
  if (args.table) assertTableAllowed(args.table);
  assertWriteAllowed("send email");
  await assertRecipientsAllowed([
    ...args.to,
    ...(args.cc ?? []),
    ...(args.bcc ?? []),
  ]);
  return pluginCall("Email", async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "POST",
      path: "/api/now/email",
      body: {
        to: args.to.join(","),
        subject: args.subject,
        text: args.body,
        ...(args.cc?.length ? { cc: args.cc.join(",") } : {}),
        ...(args.bcc?.length ? { bcc: args.bcc.join(",") } : {}),
        ...(args.table ? { table_name: args.table } : {}),
        ...(args.sysId ? { table_record_id: args.sysId } : {}),
      },
    });
    return expectResult(data, "Email API");
  });
}

export async function getEmail(sysId: string): Promise<unknown> {
  assertTableAllowed("sys_email"); // H-4: the backing table
  return pluginCall("Email", async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `/api/now/email/${encodeURIComponent(sysId)}`,
    });
    return expectResult(data, "Email API");
  });
}
