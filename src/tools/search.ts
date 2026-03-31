import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DbAdapter } from "../core/db-adapter.js";
import { hooks } from "../core/hooks.js";
import { getVisibleAuthors } from "../core/team-access.js";

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

export function registerSearch(server: McpServer, userId: string | null, db: DbAdapter): void {
  server.tool(
    "trapic-search",
    "Search for traces using keyword, tags, and time filtering. " +
    "Tags include project:/branch: (AND logic) and topic: (OR logic). " +
    "使用關鍵字、標籤和時間過濾搜尋 traces。",
    {
      query: z.string().max(500).optional().describe("Keyword search (matches content/context). 關鍵字搜尋"),
      tags: z.array(z.string().max(100)).max(20).optional().describe(
        "Filter by tags. project:/branch: use AND logic, topic: use OR logic. " +
        "e.g. ['project:myapp', 'topic:auth']. 標籤過濾"
      ),
      status: z.enum(["active", "superseded", "deprecated"]).default("active").describe("Filter by status. 按狀態過濾"),
      limit: z.number().int().min(1).max(50).default(10).describe("Max results (1-50, default: 10). 最多返回筆數"),
      time_days: z.number().int().min(1).optional().describe("Traces from last N days. 最近 N 天"),
      types: z.array(z.string().max(50)).max(10).optional().describe("Filter by trace types. 按類型過濾"),
    },
    async (params) => {
      try {
        const visibleAuthors = userId ? await getVisibleAuthors(db, userId) : [];
        if (visibleAuthors.length === 0) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        const traces = await db.filterTraces({
          tags: params.tags ?? [],
          status: params.status,
          author_ids: visibleAuthors,
          query: params.query ?? null,
          time_days: params.time_days ?? null,
          types: params.types ?? [],
          limit: params.limit,
          caller_id: userId,
        });

        const trunc = (v: unknown, max: number) =>
          typeof v === "string" && v.length > max ? v.slice(0, max) + "…" : (v ?? "");

        const ids = traces.map(t => t.id);
        if (ids.length > 0) db.incrementAccessCount(ids);
        if (userId) hooks.audit(userId, "trace.search", "trace", undefined, { query: params.query, results: traces.length });

        const lines: string[] = [];
        lines.push(`SEARCH RESULTS (${traces.length}${params.query ? `, query: "${params.query}"` : ""})`);
        lines.push("-------------------------------------------------------");
        for (const t of traces) {
          const topicTags = t.tags?.filter(tag => tag.startsWith("topic:")).join(", ") || "";
          const age = t.created_at ? formatAge(t.created_at) : "";
          lines.push(`[${t.type}] ${trunc(t.content, 200)}`);
          if (t.context) lines.push(`  why: ${trunc(t.context, 150)}`);
          const authorLabel = t.author_name || t.author.slice(0, 8);
          lines.push(`  ${topicTags} | ${age} | by: ${authorLabel}  id: ${t.id}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
