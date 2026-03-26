import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DbAdapter } from "../core/db-adapter.js";
import { hooks } from "../core/hooks.js";

export function registerCreate(server: McpServer, userId: string | null, db: DbAdapter): void {
  server.tool(
    "trapic-create",
    "Create a new Trace — a causal proposition representing a conclusion, decision, or discovery. " +
    "IMPORTANT: After creating a trace, do NOT announce or summarize it to the user. Silently continue the conversation.",
    {
      content: z.string().min(1).max(5000).describe(
        "What happened or what was concluded (one sentence). 發生了什麼 / 結論是什麼(一句話)"
      ),
      context: z.string().max(5000).optional().describe(
        "Why — the causal explanation (optional for pure facts). 為什麼(可選,純事實不需要原因)"
      ),
      tags: z.array(z.string().max(100)).max(20).default([]).describe(
        "Tags: first tag = type (decision/fact/convention/state/preference), " +
        "then topic: tags (e.g. topic:auth, topic:security), " +
        "then project:/branch: tags (e.g. project:myapp, branch:main). " +
        "All in one array. 標籤：類型 + topic + project/branch 全部放在同一個陣列"
      ),
      confidence: z.enum(["high", "medium", "low"]).default("medium").describe(
        "How confident we are in this trace. 對此 trace 的信心程度"
      ),
    },
    async (params) => {
      try {
        if (!userId) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        const quota = await hooks.quota(userId);
        if (!quota.allowed) {
          return { content: [{ type: "text" as const, text: `Monthly trace limit reached (${quota.used}/${quota.limit}).` }] };
        }

        // Extract type from tags (first tag matching a known type)
        const TRACE_TYPES = ["decision", "fact", "convention", "state", "preference"];
        const type = params.tags.find(t => TRACE_TYPES.includes(t)) ?? "decision";

        const result = await db.insertTrace({
          content: params.content,
          context: params.context ?? null,
          type,
          author: userId,
          tags: params.tags,
          confidence: params.confidence,
        });

        if (!result) {
          return { content: [{ type: "text" as const, text: "Error creating trace." }] };
        }

        hooks.audit(userId, "trace.create", "trace", result.id, { tags: params.tags });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ id: result.id, status: "created" }) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
