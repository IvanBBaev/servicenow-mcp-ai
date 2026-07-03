import { JiraError } from "../../core/errors.js";

/**
 * Helpers shared across the Jira domain layer.
 *
 * Jira Cloud's /rest/api/3 represents rich-text fields (description, comment
 * bodies, environment) as Atlassian Document Format (ADF) — a nested JSON
 * document, not a string. These helpers wrap plain text into a minimal valid
 * ADF doc for writes, and flatten an ADF tree back to readable text for reads,
 * so a caller never has to hand-build the structure for the common case.
 */

/** A minimal ADF node; the real schema is far larger but we only emit/read a subset. */
export interface AdfNode {
  type: string;
  version?: number;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Wrap plain text into a minimal ADF document (one paragraph per line). */
export function adfFromText(text: string): AdfNode {
  const lines = text.split(/\r?\n/);
  const content: AdfNode[] = lines.map((line) =>
    line.length === 0
      ? { type: "paragraph" }
      : { type: "paragraph", content: [{ type: "text", text: line }] },
  );
  return { type: "doc", version: 1, content };
}

/**
 * Flatten an ADF document (or any subtree) to plain text, best-effort. Text
 * nodes contribute their text; paragraphs, headings and list items add line
 * breaks; hard breaks become newlines. Unknown node types still recurse into
 * their content so no text is silently dropped.
 */
export function adfToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");

  if (typeof node !== "object") return "";
  const n = node as AdfNode;

  if (n.type === "text") return typeof n.text === "string" ? n.text : "";
  if (n.type === "hardBreak") return "\n";
  if (n.type === "mention") {
    const attrs = n.attrs as { text?: string } | undefined;
    return attrs?.text ?? "";
  }
  // Smart links (inlineCard/blockCard) carry no text node — only a URL in
  // attrs. Surface the URL so a description that is just a link is not blank.
  if (n.type === "inlineCard" || n.type === "blockCard") {
    const attrs = n.attrs as { url?: string } | undefined;
    const url = typeof attrs?.url === "string" ? attrs.url : "";
    return n.type === "blockCard" && url ? `${url}\n` : url;
  }

  const inner = Array.isArray(n.content)
    ? n.content.map(adfToText).join("")
    : "";
  // Block-level nodes get a trailing newline so paragraphs/list items separate.
  const block =
    n.type === "paragraph" ||
    n.type === "heading" ||
    n.type === "listItem" ||
    n.type === "blockquote" ||
    n.type === "codeBlock";
  return block ? `${inner}\n` : inner;
}

/**
 * Accept either plain text or a pre-built ADF object for a rich-text field.
 * A string is wrapped; an object is passed through untouched (advanced callers
 * can supply their own ADF). Anything else is rejected.
 */
export function toAdf(body: string | AdfNode): AdfNode {
  if (typeof body === "string") return adfFromText(body);
  if (body && typeof body === "object" && !Array.isArray(body)) return body;
  throw new JiraError("A rich-text body must be a string or an ADF object.");
}

/** Assert that a Jira response body is a non-null object before reading fields off it. */
export function expectJira<T>(data: T | null | undefined, api: string): T {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    throw new JiraError(`Unexpected response from Jira ${api}.`);
  }
  return data;
}

/**
 * Assert that a Jira response body is an array before iterating it. Several
 * endpoints return a top-level array (e.g. adding attachments, listing them),
 * for which expectJira would wrongly reject the valid response.
 */
export function expectJiraArray<T>(data: unknown, api: string): T[] {
  if (!Array.isArray(data)) {
    throw new JiraError(`Unexpected response from Jira ${api}.`);
  }
  return data as T[];
}
