/**
 * ASCII visualization helpers for terminal-based reports.
 * Renders heatmaps, timelines, and distribution charts as text art.
 */

const BAR_CHAR = "▇";

/**
 * Render a timeline bar chart showing daily/weekly trace activity.
 */
export function renderTimeline(
  traces: { created_at: string; content: string; tags: string[] }[],
  days: number = 14
): string {
  const now = new Date();
  const buckets = new Map<string, { count: number; labels: string[] }>();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { count: 0, labels: [] });
  }

  for (const t of traces) {
    const key = t.created_at.slice(0, 10);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count++;
      if (bucket.labels.length < 2) {
        // Extract a short label from tags or content
        const projectTag = t.tags?.find((tag) => tag.startsWith("project:"));
        const label = projectTag ? projectTag.slice(8) : t.content.slice(0, 25);
        if (!bucket.labels.includes(label)) bucket.labels.push(label);
      }
    }
  }

  const maxCount = Math.max(...Array.from(buckets.values()).map((b) => b.count), 1);
  const maxBarLen = 30;

  const lines: string[] = [];
  for (const [date, { count, labels }] of buckets) {
    const shortDate = date.slice(5); // MM-DD
    const barLen = Math.round((count / maxCount) * maxBarLen);
    const bar = BAR_CHAR.repeat(barLen);
    const label = labels.length > 0 ? ` (${labels.join(", ")})` : "";
    lines.push(`${shortDate} ${bar} ${count}${label}`);
  }

  return lines.join("\n");
}

/**
 * Render a horizontal bar chart showing distribution of trace types.
 */
export function renderDistribution(
  traces: { type: string }[]
): string {
  const counts = new Map<string, number>();
  for (const t of traces) {
    const type = t.type ?? "unknown";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  const total = traces.length || 1;
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const maxLabelLen = Math.max(...sorted.map(([k]) => k.length), 4);
  const maxBarLen = 30;

  const lines: string[] = [];
  for (const [type, count] of sorted) {
    const pct = Math.round((count / total) * 100);
    const barLen = Math.round((count / total) * maxBarLen);
    const bar = BAR_CHAR.repeat(barLen);
    lines.push(`${type.padEnd(maxLabelLen)}  ${bar} ${pct}% (${count})`);
  }

  return lines.join("\n");
}

/**
 * Render a member list with their stats.
 */
export function renderMembers(
  members: { user_id: string; name: string; team_name: string }[],
  traces: { author: string; created_at: string }[]
): string {
  // Count traces per member in last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const recentCounts = new Map<string, number>();
  const totalCounts = new Map<string, number>();
  const lastActive = new Map<string, string>();

  for (const t of traces) {
    totalCounts.set(t.author, (totalCounts.get(t.author) ?? 0) + 1);
    if (new Date(t.created_at) >= thirtyDaysAgo) {
      recentCounts.set(t.author, (recentCounts.get(t.author) ?? 0) + 1);
    }
    const current = lastActive.get(t.author);
    if (!current || t.created_at > current) {
      lastActive.set(t.author, t.created_at);
    }
  }

  // Deduplicate members by user_id
  const seen = new Set<string>();
  const unique: typeof members = [];
  for (const m of members) {
    if (!seen.has(m.user_id)) {
      seen.add(m.user_id);
      unique.push(m);
    }
  }

  const maxNameLen = Math.max(...unique.map((m) => m.name.length), 4);

  const lines: string[] = [];
  lines.push(
    `${"Name".padEnd(maxNameLen)}  ${"Team".padEnd(15)}  ${"30d".padStart(4)}  ${"Total".padStart(5)}  Last Active`
  );
  lines.push("─".repeat(maxNameLen + 2 + 15 + 2 + 4 + 2 + 5 + 2 + 10));

  for (const m of unique) {
    const recent = recentCounts.get(m.user_id) ?? 0;
    const total = totalCounts.get(m.user_id) ?? 0;
    const last = lastActive.get(m.user_id)?.slice(0, 10) ?? "—";
    lines.push(
      `${m.name.padEnd(maxNameLen)}  ${m.team_name.padEnd(15)}  ${String(recent).padStart(4)}  ${String(total).padStart(5)}  ${last}`
    );
  }

  return lines.join("\n");
}

interface BriefingTrace {
  id?: string;
  content: string;
  context: string | null;
  type: string;
  tags: string[];
  confidence: string;
  author: string;
  author_name?: string;
  created_at: string;
}

function relativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "1d ago";
  return `${diffDays}d ago`;
}

function windowLabel(days: number): string {
  if (days <= 1) return "today";
  return `last ${days}d`;
}

function formatTags(tags: string[]): string {
  return tags
    .filter(t => !t.startsWith("project:") && !t.startsWith("test:") && t !== "plan")
    .join(", ");
}

type BriefingData = {
  foundations: BriefingTrace[];
  teamUpdates: BriefingTrace[];
  yourProgress: BriefingTrace[];
  openPlans: BriefingTrace[];
  crossBranch: BriefingTrace[];
  topics: { summary: string; trace_count: number; latest_at: string }[];
  tags: string[];
  currentBranch: string | null;
  staleCount: number;
  teamWindow: number;
  yourWindow: number;
  asymmetryWarning: string | null;
  hasTeam: boolean;
};

function renderTrace(t: BriefingTrace, showAuthor = false): string {
  const age = relativeTime(t.created_at);
  const tags = formatTags(t.tags);
  let line = `[${t.type}] ${t.content}`;
  if (t.context) line += `\n  ${t.context}`;
  const idLabel = t.id ? ` id: ${t.id}` : "";
  const meta = [tags, `${t.confidence}`, age].filter(Boolean).join(" | ");
  if (showAuthor) {
    const by = t.author_name || t.author.slice(0, 8);
    line += `\n  ${meta} | by: ${by}${idLabel}`;
  } else if (meta) {
    line += `\n  ${meta}${idLabel}`;
  }
  return line;
}

/**
 * Render session briefing — compact markdown format for LLM consumption.
 * ~33% fewer tokens than ASCII format, better LLM parsing accuracy.
 */
export function renderRecallBriefing(data: BriefingData): string {
  const totalTraces = data.foundations.length + data.teamUpdates.length
    + data.yourProgress.length + data.openPlans.length + data.crossBranch.length;

  if (totalTraces === 0) {
    return [
      "# Trapic Briefing (new project)",
      "",
      "No knowledge captured yet. Trapic auto-captures as you work.",
    ].join("\n");
  }

  const lines: string[] = [];
  const scope = data.tags.length > 0 ? data.tags.join(", ") : "global";

  lines.push("# Trapic Briefing");
  lines.push(`scope: ${scope}`);

  // Foundations
  if (data.foundations.length > 0) {
    lines.push("");
    lines.push(`## Foundations (${data.foundations.length})`);
    for (const t of data.foundations) lines.push(renderTrace(t));
  }

  // Team Updates
  if (data.hasTeam) {
    lines.push("");
    if (data.teamUpdates.length > 0) {
      lines.push(`## Team (${windowLabel(data.teamWindow)}, ${data.teamUpdates.length})`);
      for (const t of data.teamUpdates) lines.push(renderTrace(t, true));
    } else {
      lines.push("## Team");
      lines.push("No team traces (last 30d)");
    }
  }

  // Your Progress
  lines.push("");
  if (data.yourProgress.length > 0) {
    lines.push(`## Progress (${windowLabel(data.yourWindow)}, ${data.yourProgress.length})`);
    for (const t of data.yourProgress) lines.push(renderTrace(t));
  } else {
    lines.push("## Progress");
    lines.push("No recent traces (last 7d)");
  }

  // Cross-branch
  if (data.crossBranch.length > 0 && data.currentBranch) {
    const byBranch = new Map<string, typeof data.crossBranch>();
    for (const t of data.crossBranch) {
      const b = (t.tags.find(s => s.startsWith("branch:")) ?? "branch:unknown").replace("branch:", "");
      if (!byBranch.has(b)) byBranch.set(b, []);
      byBranch.get(b)!.push(t);
    }
    lines.push("");
    lines.push(`## Other Branches (${data.crossBranch.length})`);
    for (const [branch, traces] of byBranch) {
      lines.push(`**${branch}:**`);
      for (const t of traces.slice(0, 3)) lines.push(`- [${t.type}] ${t.content} (${relativeTime(t.created_at)})`);
      if (traces.length > 3) lines.push(`- ...+${traces.length - 3} more`);
    }
  }

  // Warnings
  if (data.asymmetryWarning) {
    lines.push("");
    lines.push(`> **Info Asymmetry:** ${data.asymmetryWarning}`);
  }

  // Plans
  if (data.openPlans.length > 0) {
    lines.push("");
    lines.push(`## Plans (${data.openPlans.length})`);
    for (const t of data.openPlans) {
      lines.push(`- ${t.content} [${formatTags(t.tags)}] (${relativeTime(t.created_at)})`);
    }
  }

  // Stale
  if (data.staleCount > 0) {
    lines.push("");
    lines.push(`> **${data.staleCount} stale traces** need review — run trapic-decay()`);
  }

  // Topics
  if (data.topics.length > 0) {
    lines.push("");
    lines.push(`## Topics (${data.topics.length})`);
    for (const topic of data.topics) {
      lines.push(`- ${topic.summary} (${topic.trace_count}, ${relativeTime(topic.latest_at)})`);
    }
  }

  return lines.join("\n");
}

/**
 * Render system-wide usage statistics report.
 */
export function renderUsage(
  byAction: { action: string; count: number }[],
  byDay: { date: string; count: number }[],
  byUser: { name: string; count: number }[],
  total: number,
  days: number
): string {
  const sections: string[] = [];

  // Header
  sections.push(`System Usage Report (last ${days} days)`);
  sections.push("═".repeat(50));
  sections.push(`Total API calls: ${total}\n`);

  // By action
  if (byAction.length > 0) {
    sections.push("Tool Usage");
    sections.push("─".repeat(50));
    const maxLabel = Math.max(...byAction.map((a) => a.action.length), 6);
    const maxCount = byAction[0].count;
    for (const { action, count } of byAction) {
      const barLen = Math.round((count / maxCount) * 25);
      sections.push(`${action.padEnd(maxLabel)}  ${BAR_CHAR.repeat(barLen)} ${count}`);
    }
    sections.push("");
  }

  // By day
  if (byDay.length > 0) {
    sections.push("Daily Activity");
    sections.push("─".repeat(50));
    const maxCount = Math.max(...byDay.map((d) => d.count), 1);
    for (const { date, count } of byDay) {
      const shortDate = date.slice(5); // MM-DD
      const barLen = Math.round((count / maxCount) * 30);
      sections.push(`${shortDate} ${BAR_CHAR.repeat(barLen)} ${count}`);
    }
    sections.push("");
  }

  // By user
  if (byUser.length > 0) {
    sections.push("User Activity");
    sections.push("─".repeat(50));
    const maxName = Math.max(...byUser.map((u) => u.name.length), 4);
    const maxCount = byUser[0].count;
    for (const { name, count } of byUser) {
      const barLen = Math.round((count / maxCount) * 20);
      sections.push(`${name.padEnd(maxName)}  ${BAR_CHAR.repeat(barLen)} ${count}`);
    }
  }

  return sections.join("\n");
}
