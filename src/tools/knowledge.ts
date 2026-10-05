import { z } from "zod";
import {
  searchKnowledge,
  getKnowledgeArticle,
  knowledgeHighlights,
} from "../api/knowledge.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  encodedQuery,
  fieldList,
  shortText,
  sysId,
  type AnyToolSpec,
} from "../mcp/define.js";

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_search_knowledge",
    title: "Search knowledge articles",
    description:
      "Full-text search of knowledge articles (Knowledge API), with optional encoded query and paging.",
    package: "knowledge",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      search: shortText(1000).optional().describe("Free-text search terms."),
      query: encodedQuery().optional().describe("Extra encoded query."),
      fields: fieldList().optional().describe("Fields to return."),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    handler: async ({ search, query, fields, limit, offset }) =>
      ok({
        result: await searchKnowledge({ search, query, fields, limit, offset }),
      }),
  }),

  defineTool({
    name: "servicenow_get_knowledge_article",
    title: "Get knowledge article",
    description: "Get a knowledge article (content and metadata) by sys_id.",
    package: "knowledge",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      sys_id: sysId().describe("Article sys_id."),
    },
    handler: async ({ sys_id }) =>
      ok({ result: await getKnowledgeArticle(sys_id) }),
  }),

  defineTool({
    name: "servicenow_get_knowledge_highlights",
    title: "Featured / most-viewed knowledge",
    description:
      "List featured or most-viewed knowledge articles for the current user.",
    package: "knowledge",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      mode: z.enum(["featured", "most_viewed"]).describe("Highlight list."),
      limit: z.number().int().positive().max(100).optional(),
    },
    logFields: (args) => ({ mode: args.mode }),
    handler: async ({ mode, limit }) =>
      ok({ result: await knowledgeHighlights(mode, limit) }),
  }),
];
