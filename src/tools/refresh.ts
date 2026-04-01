import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DbAdapter, Trace } from "../core/db-adapter.js";
import { getVisibleAuthors } from "../core/team-access.js";
import { splitTags } from "../core/tag-utils.js";

/**
 * trapic-refresh — mid-session differential update.
 *
 * Unlike trapic-recall (full briefing at session start), refresh returns
 * only traces created or updated SINCE a given timestamp. Designed to be
 * called periodically (e.g. every 30 min) to keep context fresh without
 * reloading everything.
 */

function relativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function registerRefresh(server: McpServer, userId: string | null, db: DbAdapter): void {
  server.tool(
    "trapic-refresh",
    "Mid-session context update: returns only NEW or UPDATED traces since last recall/refresh. " +
    "Call periodically (e.g. every 30 min) to stay current without reloading full briefing. " +
    "中途更新：只回傳上次 recall/refresh 之後的新增/更新 trace。",
    {
      since: z.string().describe(
        "ISO timestamp of last recall or refresh (e.g. '2026-03-31T10:00:00Z'). Only traces after this time are returned."
      ),
      scope: z.array(z.string()).default([]).describe(
        "Scope tags e.g. ['project:myapp', 'branch:main']. Same as your recall scope."
      ),
      project: z.string().optional().describe("Project tag shorthand. 專案標籤"),
      team_id: z.string().uuid().optional().describe(
        "Team ID from session start. AI should pass the same team_id used in recall."
      ),
    },
    async (params) => {
      try {
        if (!userId) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        const visibleAuthors = await getVisibleAuthors(db, userId);

        // Build scope tags
        const baseTags = [...params.scope];
        if (params.project && !baseTags.some(t => t === `project:${params.project}`)) {
          baseTags.push(`project:${params.project}`);
        }

        const { scope: scopeTags } = splitTags(baseTags);

        // No project context = only show caller's own traces
        const hasProject = scopeTags.some(s => s.startsWith("project:"));
        if (!hasProject) {
          visibleAuthors.length = 0;
          visibleAuthors.push(userId);
        }

        // Calculate time_days from since timestamp
        const sinceMs = new Date(params.since).getTime();
        if (isNaN(sinceMs)) {
          return { content: [{ type: "text" as const, text: "Error: invalid 'since' timestamp." }] };
        }
        const diffMs = Date.now() - sinceMs;
        const timeDays = Math.max(diffMs / 86400000, 0.001); // at least ~1.4 minutes

        // Fetch recent traces within the time window
        const allTraces = await db.filterTraces({
          tags: scopeTags,
          status: "active",
          author_ids: visibleAuthors,
          time_days: Math.ceil(timeDays), // round up to not miss edge cases
          limit: 50,
          caller_id: userId,
        });

        // Filter precisely by since timestamp (DB uses day granularity)
        const sinceDate = new Date(params.since);
        const newTraces = allTraces.filter(t => new Date(t.created_at) > sinceDate);

        // Separate into yours vs team
        const yours = newTraces.filter(t => t.author === userId);
        const team = newTraces.filter(t => t.author !== userId);

        // Also check for newly deprecated/superseded (status changes)
        const statusChanges = await db.filterTraces({
          tags: scopeTags,
          status: "deprecated",
          author_ids: visibleAuthors,
          time_days: Math.ceil(timeDays),
          limit: 20,
          caller_id: userId,
        });
        const recentDeprecated = statusChanges.filter(t => {
          const updated = t.updated_at ?? t.created_at;
          return new Date(updated) > sinceDate;
        });

        if (newTraces.length === 0 && recentDeprecated.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No updates since ${params.since}. Context is current.` }],
          };
        }

        // Render compact markdown diff
        const lines: string[] = [];
        lines.push(`# Context Update (since ${relativeTime(params.since)})`);

        if (team.length > 0) {
          lines.push("");
          lines.push(`## Team (+${team.length})`);
          for (const t of team) {
            const by = t.author_name || t.author.slice(0, 8);
            lines.push(`+ [${t.type}] ${t.content} (${relativeTime(t.created_at)}, by: ${by})`);
          }
        }

        if (yours.length > 0) {
          lines.push("");
          lines.push(`## You (+${yours.length})`);
          for (const t of yours) {
            lines.push(`+ [${t.type}] ${t.content} (${relativeTime(t.created_at)})`);
          }
        }

        if (recentDeprecated.length > 0) {
          lines.push("");
          lines.push(`## Deprecated (-${recentDeprecated.length})`);
          for (const t of recentDeprecated) {
            lines.push(`- [${t.type}] ${t.content}`);
          }
        }

        // Track access
        const ids = newTraces.map(t => t.id);
        if (ids.length > 0) db.incrementAccessCount(ids);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
