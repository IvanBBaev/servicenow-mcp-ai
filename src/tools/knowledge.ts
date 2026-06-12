import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchKnowledge,
  getKnowledgeArticle,
  knowledgeHighlights,
} from "../api/knowledge.js";
import { ok } from "../result.js";
import { runTool } from "./util.js";

export function registerKnowledgeTools(server: McpServer): void {
  server.registerTool(
    "servicenow_search_knowledge",
    {
      title: "Search knowledge articles",
      description:
        "Full-text search of knowledge articles (Knowledge API), with optional encoded query and paging.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        search: z.string().optional().describe("Free-text search terms."),
        query: z
          .string()
          .optional()
          .describe("Encoded query for additional filtering."),
        fields: z.array(z.string()).optional().describe("Fields to return."),
        limit: z.number().int().positive().max(100).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async ({ search, query, fields, limit, offset }) =>
      runTool("servicenow_search_knowledge", {}, async () => {
        const result = await searchKnowledge({
          search,
          query,
          fields,
          limit,
          offset,
        });
        return ok({ result });
      }),
  );

  server.registerTool(
    "servicenow_get_knowledge_article",
    {
      title: "Get knowledge article",
      description: "Get a knowledge article (content and metadata) by sys_id.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        sys_id: z.string().describe("sys_id of the knowledge article."),
      },
    },
    async ({ sys_id }) =>
      runTool("servicenow_get_knowledge_article", {}, async () => {
        const result = await getKnowledgeArticle(sys_id);
        return ok({ result });
      }),
  );

  server.registerTool(
    "servicenow_knowledge_highlights",
    {
      title: "Featured / most-viewed knowledge",
      description:
        "List featured or most-viewed knowledge articles for the current user.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        mode: z
          .enum(["featured", "most_viewed"])
          .describe("Which highlight list to return."),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ mode, limit }) =>
      runTool("servicenow_knowledge_highlights", { mode }, async () => {
        const result = await knowledgeHighlights(mode, limit);
        return ok({ result });
      }),
  );
}
