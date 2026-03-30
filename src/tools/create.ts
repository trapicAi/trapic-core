import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DbAdapter } from "../core/db-adapter.js";
import { hooks } from "../core/hooks.js";

const VALID_TYPES = ["decision", "fact", "convention", "state", "preference"];

export function registerCreate(server: McpServer, userId: string | null, db: DbAdapter): void {
  server.tool(
    "trapic-create",
    "Create a new Trace — a piece of knowledge worth remembering for future conversations. " +
    "Content MUST be in English. Every trace MUST have a project: tag. " +
    "Do NOT record trivial changes (CSS tweaks, import fixes, typos). " +
    "Only record knowledge useful in FUTURE conversations. " +
    "After creating, do NOT announce it to the user.\n\n" +
    "Type guide:\n" +
    "- decision: A choice made between alternatives (e.g. 'Use Stripe Connect Standard instead of Express')\n" +
    "- fact: A discovered truth (e.g. 'PostgreSQL does NOT auto-index foreign keys')\n" +
    "- convention: An agreed pattern (e.g. 'All API access via RPC, never .from()')\n" +
    "- state: A status change (e.g. 'Marketplace MVP complete, starting Phase 2')\n" +
    "- preference: A user preference (e.g. 'Prefer minimal UI, no emoji in code')",
    {
      content: z.string().min(1).max(50000).describe(
        "What was decided/discovered — in English, one clear sentence. Can also be a full markdown document (tables, code blocks, lists)."
      ),
      context: z.string().max(50000).optional().describe(
        "Why this matters — the causal explanation (optional for pure facts). Supports markdown."
      ),
      type: z.enum(["decision", "fact", "convention", "state", "preference"]).default("decision").describe(
        "Trace type: decision (choice made), fact (truth discovered), convention (pattern agreed), state (status change), preference (user preference)"
      ),
      tags: z.array(z.string().max(100)).max(20).default([]).describe(
        "Tags array: topic: tags (e.g. topic:auth, topic:database), " +
        "project: tag (REQUIRED, e.g. project:trapic-web), " +
        "branch: tag (e.g. branch:main). " +
        "Do NOT include the type here — use the type parameter instead."
      ),
      confidence: z.enum(["high", "medium", "low"]).default("medium").describe(
        "Confidence level: high (verified), medium (likely correct), low (uncertain)"
      ),
      caused_by: z.array(z.string()).max(10).default([]).describe(
        "IDs of traces that caused/led to this one — builds a reasoning chain. Use when this decision was caused by a previous discovery or fact."
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

        // Build final tags: type + user tags (deduplicated)
        const finalTags = [params.type, ...params.tags];
        const seen = new Set<string>();
        const deduped = finalTags.filter(t => {
          if (seen.has(t)) return false;
          seen.add(t);
          // Remove old-style type tags from user input
          if (VALID_TYPES.includes(t) && t !== params.type) return false;
          return true;
        });

        const result = await db.insertTrace({
          content: params.content,
          context: params.context ?? null,
          type: params.type,
          author: userId,
          tags: deduped,
          confidence: params.confidence,
          caused_by: params.caused_by.length > 0 ? params.caused_by : undefined,
        });

        if (!result) {
          return { content: [{ type: "text" as const, text: "Error creating trace." }] };
        }

        hooks.audit(userId, "trace.create", "trace", result.id, { tags: deduped });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ id: result.id, type: params.type, status: "created" }) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
