import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DbAdapter, TraceUpdate } from "../core/db-adapter.js";
import { hooks } from "../core/hooks.js";

export function registerUpdate(server: McpServer, userId: string | null, db: DbAdapter): void {
  server.tool(
    "trapic-update",
    "Update an existing trace — change status, tags, content/context, or mark as superseded. " +
    "更新現有 trace — 可以變更狀態、標籤、content/context，或標記為被取代。",
    {
      trace_id: z.string().uuid().describe("ID of the trace to update. 要更新的 trace ID"),
      content: z.string().max(5000).optional().describe("Updated content text. 更新的 content 文字"),
      context: z.string().max(5000).optional().describe("Updated context text. 更新的 context 文字"),
      status: z.enum(["active", "superseded", "deprecated"]).optional().describe("New status for the trace. trace 的新狀態"),
      superseded_by: z.string().uuid().optional().describe("ID of the trace that supersedes this one. 取代此 trace 的新 trace ID"),
      tags: z.array(z.string().max(100)).max(20).optional().describe("Replace tags with this new list. 用新的標籤列表替換"),
      confidence: z.enum(["high", "medium", "low"]).optional().describe("Updated confidence level. 更新的信心程度"),
    },
    async (params) => {
      try {
        if (!userId) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        const update: TraceUpdate = {};
        if (params.content !== undefined) update.content = params.content;
        if (params.context !== undefined) update.context = params.context;
        if (params.tags !== undefined) update.tags = params.tags;
        if (params.confidence !== undefined) update.confidence = params.confidence;
        if (params.superseded_by !== undefined) {
          update.superseded_by = params.superseded_by;
          update.status = "superseded";
        } else if (params.status !== undefined) {
          update.status = params.status;
        }

        if (Object.keys(update).length === 0) {
          return { content: [{ type: "text" as const, text: "No fields to update." }] };
        }

        const data = await db.updateTrace(params.trace_id, userId, update);
        if (!data) {
          return { content: [{ type: "text" as const, text: "Trace not found or you don't have permission." }] };
        }

        hooks.audit(userId, "trace.update", "trace", params.trace_id);

        const lines = [
          `UPDATED ${data.id}`,
          `[${data.status}] ${data.content}`,
          data.superseded_by ? `superseded_by: ${data.superseded_by}` : null,
          `tags: ${data.tags?.join(", ") || ""}`,
          `confidence: ${data.confidence}`,
        ].filter(Boolean);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
