import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DbAdapter } from "../core/db-adapter.js";
import { getVisibleAuthors } from "../core/team-access.js";
import { hooks } from "../core/hooks.js";

const HALF_LIVES: Record<string, number> = {
  state: 30,
  decision: 90,
  convention: 180,
  preference: 180,
  fact: 365,
};

export function registerDecay(server: McpServer, userId: string | null, db: DbAdapter): void {
  server.tool(
    "trapic-decay",
    "Scan for stale/decaying knowledge. Shows traces that have decayed below confidence threshold " +
    "based on their type-specific half-life. Use dry_run=true (default) to preview, false to update scores. " +
    "掃描過期知識。根據類型半衰期顯示已衰減的 traces。",
    {
      project: z.string().optional().describe("Project tag to filter. 專案標籤"),
      tags: z.array(z.string()).default([]).describe("Filter tags (e.g. ['project:myapp']). 過濾標籤"),
      threshold: z.number().min(0).max(1).default(0.3).describe("Decay score below this is flagged as stale (0-1, default: 0.3)."),
      dry_run: z.boolean().default(true).describe("Preview only, don't update scores (default: true)."),
    },
    async (params) => {
      try {
        if (!userId) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        const visibleAuthors = await getVisibleAuthors(db, userId);

        const staleTraces = await db.calculateDecayScores({
          author_ids: visibleAuthors,
          flag_threshold: params.threshold,
          dry_run: params.dry_run,
          scope: params.project ? [`project:${params.project}`, ...params.tags] : params.tags,
          caller_id: userId,
        });

        const filtered = params.project
          ? staleTraces.filter(t => t.tags?.some(tag => tag === `project:${params.project}`))
          : staleTraces;

        hooks.audit(userId, "trace.search", "trace", undefined, {
          action: "decay_scan", dry_run: params.dry_run, stale_found: filtered.length,
        });

        const lines: string[] = [];
        lines.push(`# Decay Scan (${params.dry_run ? "dry_run" : "applied"}, threshold: ${params.threshold})`);
        lines.push(`Half-lives: state=${HALF_LIVES.state}d decision=${HALF_LIVES.decision}d convention=${HALF_LIVES.convention}d fact=${HALF_LIVES.fact}d`);
        lines.push(`Stale traces: ${filtered.length}`);
        for (const t of filtered) {
          lines.push(`- **[${t.type}]** ${t.content}`);
          lines.push(`  age: ${t.age_days}d | decay: ${t.decay_score} | half-life: ${t.half_life_days}d | id: ${t.id}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );

  server.tool(
    "trapic-review-stale",
    "Review a stale trace: confirm it's still valid (resets decay) or deprecate it. " +
    "審查過期 trace：確認仍然有效（重設衰減）或標記為已棄用。",
    {
      trace_id: z.string().uuid().describe("ID of the stale trace to review."),
      action: z.enum(["confirm", "deprecate"]).describe("confirm = still valid, deprecate = no longer relevant."),
      reason: z.string().optional().describe("Why this trace is being confirmed or deprecated."),
    },
    async (params) => {
      try {
        if (!userId) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        const visibleAuthors = await getVisibleAuthors(db, userId);
        const trace = await db.getTraceForReview(params.trace_id, visibleAuthors, userId);
        if (!trace) {
          return { content: [{ type: "text" as const, text: "Error: Trace not found or not authorized." }] };
        }

        if (params.action === "confirm") {
          const ok = await db.confirmStaleTrace(params.trace_id, visibleAuthors);
          if (!ok) return { content: [{ type: "text" as const, text: "Error: Operation failed." }] };
          hooks.audit(userId, "trace.update", "trace", params.trace_id, { action: "decay_confirm", reason: params.reason });
          return { content: [{ type: "text" as const, text: `CONFIRMED ${params.trace_id}\n${trace.content}\nDecay timer reset. Trace remains active.` }] };
        } else {
          const ok = await db.deprecateStaleTrace(params.trace_id, visibleAuthors);
          if (!ok) return { content: [{ type: "text" as const, text: "Error: Operation failed." }] };
          hooks.audit(userId, "trace.update", "trace", params.trace_id, { action: "decay_deprecate", reason: params.reason });
          return { content: [{ type: "text" as const, text: `DEPRECATED ${params.trace_id}\n${trace.content}\nReason: ${params.reason || "stale"}\nWill no longer appear in searches.` }] };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
