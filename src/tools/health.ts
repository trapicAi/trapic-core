import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DbAdapter, HealthData } from "../core/db-adapter.js";
import { getVisibleAuthors } from "../core/team-access.js";
import { hooks } from "../core/hooks.js";

const BAR = "▇";

function calculateCQS(data: HealthData): { score: number; breakdown: Record<string, number> } {
  const healthPct = data.health_pct ?? 0;
  const active = data.active_traces ?? 0;
  const total = data.total_traces ?? 0;
  const recent7d = data.recent_7d ?? 0;
  const byType = data.by_type ?? {};
  const typeCount = Object.keys(byType).length;

  // Freshness (30 pts): non-stale ratio
  const freshness = Math.round(healthPct * 0.3);

  // Diversity (20 pts): type coverage (5 types = full score)
  const diversity = Math.round(Math.min(typeCount / 5, 1) * 20);

  // Activity (20 pts): at least 2 traces/week = full score
  const activity = Math.round(Math.min(recent7d / 2, 1) * 20);

  // Depth (15 pts): 50+ active traces = full score
  const depth = Math.round(Math.min(active / 50, 1) * 15);

  // Hygiene (15 pts): traces cleaned up (total - active = deprecated/superseded)
  const cleaned = total - active;
  const hygiene = total > 0
    ? Math.round(Math.min(cleaned / Math.max(active * 0.1, 1), 1) * 15)
    : 0;

  const score = freshness + diversity + activity + depth + hygiene;
  return { score, breakdown: { freshness, diversity, activity, depth, hygiene } };
}

function renderHealthReport(data: HealthData): string {
  const lines: string[] = [];
  const healthPct = data.health_pct;
  const { score: cqs, breakdown } = calculateCQS(data);
  const grade = cqs >= 80 ? "A" : cqs >= 60 ? "B" : cqs >= 40 ? "C" : cqs >= 20 ? "D" : "F";
  const status = cqs >= 80 ? "EXCELLENT" : cqs >= 60 ? "GOOD" : cqs >= 40 ? "FAIR" : cqs >= 20 ? "NEEDS WORK" : "CRITICAL";

  lines.push("TRAPIC KNOWLEDGE HEALTH REPORT");
  lines.push("=".repeat(55));
  lines.push(`Context Quality Score: ${cqs}/100 (${grade} — ${status})`);
  lines.push("");
  lines.push("CQS BREAKDOWN");
  lines.push("-".repeat(55));
  const maxPts: Record<string, number> = { freshness: 30, diversity: 20, activity: 20, depth: 15, hygiene: 15 };
  for (const [dim, pts] of Object.entries(breakdown)) {
    const max = maxPts[dim] ?? 0;
    const bar = BAR.repeat(Math.round((pts / Math.max(max, 1)) * 20));
    lines.push(`  ${dim.padEnd(12)} ${bar.padEnd(20)} ${pts}/${max}`);
  }
  lines.push("");

  const healthy = (data.active_traces ?? 0) - (data.stale_traces ?? 0);
  lines.push("OVERVIEW");
  lines.push("-".repeat(55));
  lines.push(`  Active:      ${data.active_traces}  (healthy: ${healthy}, stale: ${data.stale_traces})`);
  lines.push(`  Total:       ${data.total_traces}`);
  lines.push("");
  lines.push("ACTIVITY");
  lines.push("-".repeat(55));
  const r7 = data.recent_7d as number;
  const r30 = data.recent_30d as number;
  const weeklyRate = r30 > 0 ? Math.round(r7 / (r30 / 4) * 100) : 0;
  const trend = weeklyRate > 120 ? "accelerating" : weeklyRate > 80 ? "steady" : "slowing";
  lines.push(`  Last 7 days:   ${r7} traces`);
  lines.push(`  Last 30 days:  ${r30} traces`);
  lines.push(`  Trend:         ${trend} (${weeklyRate}% of weekly avg)`);
  lines.push("");

  const byType = data.by_type as Record<string, number> | null;
  if (byType && Object.keys(byType).length > 0) {
    lines.push("TYPE DISTRIBUTION");
    lines.push("-".repeat(55));
    const sorted = Object.entries(byType).sort((a, b) => b[1] - a[1]);
    const maxCount = sorted[0]?.[1] ?? 1;
    const maxLabel = Math.max(...sorted.map(([k]) => k.length), 6);
    for (const [type, count] of sorted) {
      const barLen = Math.round((count / maxCount) * 25);
      lines.push(`  ${type.padEnd(maxLabel)}  ${BAR.repeat(barLen)} ${count}`);
    }
    lines.push("");
  }

  const active = data.active_traces ?? 0;
  if (active > 0) {
    const stale = data.stale_traces ?? 0;
    const healthBar = BAR.repeat(Math.round((active - stale) / active * 30));
    const staleBar = "x".repeat(Math.round(stale / active * 30));
    lines.push("HEALTH BAR");
    lines.push("-".repeat(55));
    lines.push(`  ${healthBar}${staleBar}`);
    lines.push(`  ${"healthy".padEnd(15)} ${"stale".padStart(15)}`);
  }

  return lines.join("\n");
}

export function registerHealth(server: McpServer, userId: string | null, db: DbAdapter): void {
  server.tool(
    "trapic-health",
    "Knowledge health report: shows project health score, type distribution, " +
    "stale/healthy ratio, and activity trends. " +
    "知識健康報告：顯示專案健康分數、類型分布、衰減比例和活動趨勢。",
    {
      project: z.string().optional().describe("Project tag to filter. 專案標籤"),
      tags: z.array(z.string()).default([]).describe("Filter tags (e.g. ['project:myapp']). 過濾標籤"),
    },
    async (params) => {
      try {
        if (!userId) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        const visibleAuthors = await getVisibleAuthors(db, userId);
        const filterTags = params.project ? [`project:${params.project}`, ...params.tags] : params.tags;
        const data = await db.getKnowledgeHealth(filterTags, visibleAuthors);

        if (!data) {
          return { content: [{ type: "text" as const, text: "Error fetching health data." }] };
        }

        hooks.audit(userId, "trace.search", "trace", undefined, { action: "health_report", tags: filterTags });

        return {
          content: [{ type: "text" as const, text: renderHealthReport(data) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
