import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DbAdapter } from "../core/db-adapter.js";

export function registerMyTeams(server: McpServer, userId: string | null, db: DbAdapter): void {
  server.tool(
    "trapic-my-teams",
    "List your teams. Use at session start to pick which team to record traces in. " +
    "AI should remember the chosen team_id for the rest of the session. " +
    "列出你的 teams。在 session 開始時選擇要記錄在哪個 team。",
    {},
    async () => {
      try {
        if (!userId) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        const teams = await db.getUserTeams(userId);

        if (teams.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No teams. All traces will be private to you.\n\nTo create a team, use the admin panel.",
            }],
          };
        }

        if (teams.length === 1) {
          const t = teams[0];
          return {
            content: [{
              type: "text" as const,
              text: `You have 1 team: **${t.name}** (${t.id})\nProjects: ${t.project_tags?.join(", ") || "(none)"}\n\nAuto-selected. Use this team_id for all traces in this session.`,
            }],
          };
        }

        const lines = teams.map((t, i) =>
          `${i + 1}. **${t.name}** (${t.id})\n   Projects: ${t.project_tags?.join(", ") || "(none)"}`
        );

        return {
          content: [{
            type: "text" as const,
            text: `You have ${teams.length} teams:\n\n${lines.join("\n\n")}\n\nWhich team should traces be recorded in for this session?`,
          }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
