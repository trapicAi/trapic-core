import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DbAdapter } from "../core/db-adapter.js";
import { getVisibleAuthors } from "../core/team-access.js";

export function registerGet(server: McpServer, userId: string | null, db: DbAdapter): void {
  server.tool(
    "trapic-get",
    "Get full content of a single trace by ID. Use after trapic-search to read complete details. " +
    "用 ID 取得單筆 trace 的完整內容。在 trapic-search 找到目標後使用。",
    {
      trace_id: z.string().uuid().describe(
        "ID of the trace to retrieve. 要取得的 trace ID"
      ),
    },
    async (params) => {
      try {
        if (!userId) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        const visibleAuthors = await getVisibleAuthors(db, userId);
        if (visibleAuthors.length === 0) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        const trace = await db.getTraceFull(params.trace_id, visibleAuthors, userId);
        if (!trace) {
          return { content: [{ type: "text" as const, text: "Trace not found or access denied." }] };
        }

        db.incrementAccessCount([params.trace_id]);

        const tags = trace.tags?.join(", ") || "";
        const lines = [
          `TRACE ${trace.id}`,
          `[${trace.type}] ${trace.content}`,
          trace.context ? `why: ${trace.context}` : null,
          `confidence: ${trace.confidence} | ${trace.created_at}`,
          `tags: ${tags}`,
          `author: ${trace.author_name || trace.author}`,
          trace.caused_by?.length ? `caused_by: ${trace.caused_by.join(", ")}` : null,
        ].filter(Boolean);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
