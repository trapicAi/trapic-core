import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DbAdapter, Trace } from "../core/db-adapter.js";
import { getVisibleAuthors } from "../core/team-access.js";
import { hooks } from "../core/hooks.js";
import { splitTags } from "../core/tag-utils.js";
import { renderRecallBriefing } from "../ascii.js";

type TraceRow = {
  id: string;
  content: string;
  context: string | null;
  tags: string[];
  type: string;
  confidence: string;
  author: string;
  author_name?: string;
  created_at: string;
};

function toTraceRow(t: Trace): TraceRow {
  return {
    id: t.id, content: t.content, context: t.context, tags: t.tags,
    type: t.type, confidence: t.confidence, author: t.author,
    author_name: t.author_name, created_at: t.created_at,
  };
}

export function registerRecall(server: McpServer, userId: string | null, db: DbAdapter): void {
  server.tool(
    "trapic-recall",
    "Session briefing: load project foundations, team updates, your progress, and open plans. " +
    "Call at session start for automatic context loading. " +
    "Session 簡報：載入專案基礎、團隊更新、你的進度、待辦計畫。",
    {
      context: z.string().describe(
        "Current work context: git diff, file paths, branch name, or description. " +
        "當前工作脈絡：git diff、檔案路徑、分支名稱、或描述"
      ),
      project: z.string().optional().describe("Project tag to filter by. 專案標籤過濾"),
      tags: z.array(z.string()).default([]).describe(
        "Filter tags e.g. ['project:myapp', 'branch:main']. 過濾標籤"
      ),
      max_contexts: z.number().int().min(0).max(10).default(5).describe("Maximum active contexts/topics to return (0-10)."),
      team_id: z.string().uuid().optional().describe(
        "Team ID for this session. If omitted, auto-detects: 1 team = auto-select, 2+ teams = returns team list for user to pick. " +
        "AI should remember the chosen team_id and pass it on subsequent recalls."
      ),
      plugin_version: z.string().optional().describe("Trapic plugin version (auto-detected). Used for update notifications."),
    },
    async (params) => {
      try {
        if (!userId) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        // Team resolution
        const userTeams = await db.getUserTeams(userId);
        let sessionTeamId = params.team_id ?? null;
        let teamPrompt = "";

        if (!sessionTeamId && userTeams.length > 1) {
          // Multiple teams, no team_id provided — ask user
          const teamLines = userTeams.map((t, i) =>
            `${i + 1}. **${t.name}** (${t.id}) — projects: ${t.project_tags?.join(", ") || "(none)"}`
          );
          teamPrompt = `\n\n> **Team Selection Required**\n> You have ${userTeams.length} teams:\n> ${teamLines.join("\n> ")}\n> Which team should traces be recorded in? Pass the team_id on next recall.\n`;
        } else if (!sessionTeamId && userTeams.length === 1) {
          sessionTeamId = userTeams[0].id;
          teamPrompt = `\n\n> **Team:** ${userTeams[0].name} (auto-selected). Use team_id: ${userTeams[0].id}\n`;
        }

        const visibleAuthors = await getVisibleAuthors(db, userId);
        const teamAuthors = visibleAuthors.filter(a => a !== userId);

        // Build base tags from project param + tags param
        const baseTags = [...params.tags];
        if (params.project && !baseTags.some(t => t === `project:${params.project}`)) {
          baseTags.push(`project:${params.project}`);
        }

        // Split into project tags (AND) and branch
        const { scope: scopeTags } = splitTags(baseTags);
        const projectTags = scopeTags.filter(s => s.startsWith("project:"));
        const currentBranch = scopeTags.find(s => s.startsWith("branch:")) ?? null;

        // No project context = read-only mode: only show caller's own traces
        const hasProject = projectTags.length > 0;
        if (!hasProject) {
          // Restrict to self only — don't expand team members
          visibleAuthors.length = 0;
          visibleAuthors.push(userId);
          teamAuthors.length = 0;
        }

        /** Cascade query: try each window until we get >= 1 result */
        async function cascadeQuery(opts: {
          types: string[];
          authorIds: string[];
          windows: number[];
          limit: number;
          extraTags?: string[];
          excludeStale: boolean;
          projectOnly?: boolean; // true = use only project tags, false = use all scope tags
        }): Promise<{ traces: TraceRow[]; usedWindow: number }> {
          const queryTags = opts.projectOnly
            ? [...projectTags, ...(opts.extraTags ?? [])]
            : [...scopeTags, ...(opts.extraTags ?? [])];

          for (const window of opts.windows) {
            const traces = await db.filterTraces({
              tags: queryTags,
              status: "active",
              author_ids: opts.authorIds,
              time_days: window,
              types: opts.types,
              limit: opts.limit,
              query: null,
              caller_id: userId,
              exclude_stale: opts.excludeStale,
            });
            if (traces.length > 0) return { traces: traces.map(toTraceRow), usedWindow: window };
          }
          return { traces: [], usedWindow: opts.windows[opts.windows.length - 1] };
        }

        // 1. Project foundations (project-wide, no branch filter)
        const { traces: foundations } = await cascadeQuery({
          types: ["convention", "decision", "preference"],
          authorIds: visibleAuthors,
          windows: [90, 365],
          limit: 15,
          excludeStale: true,
          projectOnly: true,
        });

        // 2. Team updates
        let teamUpdates: TraceRow[] = [];
        let teamWindow = 0;
        if (teamAuthors.length > 0) {
          const result = await cascadeQuery({
            types: [], authorIds: teamAuthors, windows: [7, 14, 30],
            limit: 10, excludeStale: true, projectOnly: false,
          });
          teamUpdates = result.traces;
          teamWindow = result.usedWindow;
        }

        // 3. Your progress
        const { traces: yourProgress, usedWindow: yourWindow } = await cascadeQuery({
          types: [], authorIds: [userId], windows: [1, 3, 7],
          limit: 10, excludeStale: false, projectOnly: false,
        });

        // 4. Open plans (project-wide)
        const { traces: rawPlans } = await cascadeQuery({
          types: [], authorIds: visibleAuthors, windows: [90],
          limit: 15, extraTags: ["plan"], excludeStale: false, projectOnly: true,
        });
        const openPlans = rawPlans.filter(t =>
          !t.tags.some(tag => tag === "done" || tag.startsWith("done:"))
        );

        // 5. Cross-branch activity
        let crossBranchTraces: TraceRow[] = [];
        if (currentBranch) {
          const { traces: projectWide } = await cascadeQuery({
            types: [], authorIds: visibleAuthors, windows: [7, 14, 30],
            limit: 15, excludeStale: true, projectOnly: true,
          });
          crossBranchTraces = projectWide.filter(t =>
            !t.tags.includes(currentBranch) &&
            t.tags.some(s => s.startsWith("branch:"))
          );
        }

        // 6. Active topics
        let activeTopics: { summary: string; trace_count: number; latest_at: string }[] = [];
        if (params.max_contexts > 0 && db.findCandidateContexts) {
          const ctxData = await db.findCandidateContexts(baseTags, visibleAuthors);
          activeTopics = ctxData.slice(0, params.max_contexts).map(c => ({
            summary: c.summary, trace_count: c.trace_count, latest_at: "",
          }));
        }

        // Increment access count
        const allReturned = [...foundations, ...teamUpdates, ...yourProgress, ...openPlans, ...crossBranchTraces];
        if (allReturned.length > 0) {
          db.incrementAccessCount(allReturned.map(t => t.id));
        }

        // Info asymmetry detection
        const teamLatest = teamUpdates.length > 0 ? new Date(teamUpdates[0].created_at) : null;
        const yourLatest = yourProgress.length > 0 ? new Date(yourProgress[0].created_at) : null;
        let asymmetryWarning: string | null = null;

        if (teamLatest && yourLatest) {
          const gapDays = Math.abs(teamLatest.getTime() - yourLatest.getTime()) / 86400000;
          if (gapDays >= 3) {
            asymmetryWarning = teamLatest > yourLatest
              ? `Your latest trace is ${Math.round(gapDays)}d behind the team.`
              : `Team's latest trace is ${Math.round(gapDays)}d behind yours.`;
          }
        } else if (teamLatest && !yourLatest) {
          asymmetryWarning = "You have no recent traces. Your work is not being captured.";
        } else if (!teamLatest && yourLatest && teamAuthors.length > 0) {
          asymmetryWarning = "No recent team traces found. You may be working in isolation.";
        }

        // Stale count
        let staleCount = 0;
        {
          const staleData = await db.filterTraces({
            tags: projectTags,
            status: "active",
            author_ids: visibleAuthors,
            time_days: null,
            types: [],
            limit: 100,
            query: null,
            caller_id: userId,
            exclude_stale: false,
          });
          staleCount = staleData.filter(t => t.flagged_for_review === true).length;
        }

        hooks.audit(userId, "trace.search", "trace", undefined, {
          action: "recall",
          foundations: foundations.length,
          team_updates: teamUpdates.length,
          your_progress: yourProgress.length,
          open_plans: openPlans.length,
        });

        const output = renderRecallBriefing({
          foundations, teamUpdates, yourProgress, openPlans,
          crossBranch: crossBranchTraces,
          topics: activeTopics,
          tags: scopeTags,
          currentBranch, staleCount, teamWindow, yourWindow,
          asymmetryWarning, hasTeam: teamAuthors.length > 0,
        });

        // Plugin version check
        const LATEST_PLUGIN_VERSION = "0.7.0";
        let versionNotice = "";
        if (params.plugin_version && params.plugin_version !== LATEST_PLUGIN_VERSION) {
          const [curMajor, curMinor] = params.plugin_version.split(".").map(Number);
          const [latMajor, latMinor] = LATEST_PLUGIN_VERSION.split(".").map(Number);
          if (latMajor > curMajor || (latMajor === curMajor && latMinor > curMinor)) {
            versionNotice = `\n\n> **Plugin update available:** v${params.plugin_version} → v${LATEST_PLUGIN_VERSION}. Run: \`claude plugin update trapic\``;
          }
        }

        return { content: [{ type: "text" as const, text: output + teamPrompt + versionNotice }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
