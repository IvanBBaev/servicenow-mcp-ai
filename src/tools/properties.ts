import { sdkGuard } from "../mcp/sdk-guard.js";
import { z } from "zod";
import {
  PROPERTIES_TABLE,
  getProperties,
  isSecretProperty,
  maskedProperty,
  resolveProperty,
  setPropertyValue,
} from "../api/properties.js";
import { REDACTED } from "../core/redaction.js";
import { journaledWrite, resultModCount } from "../core/write-journal.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  longText,
  shortText,
  type AnyToolSpec,
} from "../mcp/define.js";
import { applyInput, planPreview, shouldApply } from "../mcp/write-mode.js";
import { snString } from "../api/shared.js";

/**
 * S-10 — opt-in `properties` package: read and set system properties
 * (`sys_properties`). The read and the write are separate tools so
 * SN_PACKAGES_READONLY=properties keeps the read and drops the write.
 */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_get_properties",
    title: "Get system properties",
    description:
      "Read system properties (sys_properties) by exact name or name prefix: value, type, description, read/write roles, scope and last update. Password-type and secret-looking values are masked; long values are truncated.",
    package: "properties",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      name: shortText()
        .optional()
        .describe("Exact property name, e.g. 'glide.ui.session_timeout'."),
      prefix: shortText()
        .optional()
        .describe("Name prefix, e.g. 'glide.email.'."),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Maximum properties (default 50)."),
      value_max_chars: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .optional()
        .describe(
          "Truncate each value to this many characters (default 4000).",
        ),
    },
    handler: async ({ name, prefix, limit, value_max_chars }) =>
      ok(
        await getProperties({
          name,
          prefix,
          limit,
          valueMaxChars: value_max_chars,
        }),
      ),
  }),

  defineTool({
    name: "servicenow_set_property",
    title: "Set system property",
    description:
      "Set the value of one existing system property (sys_properties) by name. The plan preview shows the current and the new value; the applied write is journaled and revertible (except for secret properties, whose values are never journaled).",
    package: "properties",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      name: shortText().describe(
        "Exact property name, e.g. 'glide.ui.session_timeout'.",
      ),
      value: longText(65_536).describe("The new value (as a string)."),
      apply: applyInput,
    },
    logFields: (args) => ({ name: args.name }),
    handler: async ({ name, value, apply }) => {
      const property = await resolveProperty(name);
      const sysId = snString(property.sys_id);
      const secret = isSecretProperty(property);
      const shownValue = secret ? REDACTED : value;
      if (!shouldApply(apply)) {
        return planPreview(
          {
            action: "update",
            table: PROPERTIES_TABLE,
            sys_id: sysId,
            before: maskedProperty(property),
            after: { value: shownValue },
          },
          {
            property: name,
            ...(!secret && snString(property.value) === value
              ? { unchanged: true }
              : {}),
            ...(await sdkGuard(
              { table: PROPERTIES_TABLE, sys_id: sysId, record: property },
              "plan",
            )),
          },
        );
      }
      const sdk = await sdkGuard(
        { table: PROPERTIES_TABLE, sys_id: sysId, record: property },
        "apply",
      );
      const record = await journaledWrite(
        {
          action: "update",
          table: PROPERTIES_TABLE,
          sys_id: sysId,
          fields: { value: shownValue },
          before: maskedProperty(property),
        },
        () => setPropertyValue(sysId, value),
        (r) => ({ after_mod_count: resultModCount(r) }),
      );
      return ok({
        message: `Property "${name}" updated`,
        property: secret ? { ...record, value: REDACTED } : record,
        note: "Some properties are cached by the instance and take effect only after a cache flush or a node restart.",
        ...sdk,
      });
    },
  }),
];
