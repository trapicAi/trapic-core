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

/**
 * Render session briefing — 4 structured sections for session start.
 */
export function renderRecallBriefing(data: {
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
}): string {
  const totalTraces = data.foundations.length + data.teamUpdates.length
    + data.yourProgress.length + data.openPlans.length + data.crossBranch.length;

  if (totalTraces === 0) {
    const tagsStr = data.tags.length > 0 ? JSON.stringify(data.tags) : '["project:<name>", "branch:main"]';
    return [
      "TRAPIC SESSION BRIEFING (new project)",
      "=".repeat(55),
      "",
      "No knowledge captured yet for this project.",
      "",
      "Trapic will automatically capture decisions, conventions,",
      "and discoveries as you work. You can also manually record:",
      "",
      "  trapic-create({",
      '    content: "Use Vite for bundling",',
      '    context: "Chose over Next.js because no SSR needed",',
      `    tags: ["decision", "topic:bundler", "topic:architecture", ...${tagsStr}]`,
      "  })",
    ].join("\n");
  }

  const lines: string[] = [];
  const filterStr = data.tags.length > 0 ? data.tags.join(", ") : "global";

  lines.push("TRAPIC SESSION BRIEFING");
  lines.push("=".repeat(55));
  lines.push(`scope: ${filterStr}`);
  lines.push("");

  // Section 1: Project Foundations
  if (data.foundations.length > 0) {
    lines.push(`PROJECT FOUNDATIONS (${data.foundations.length})`);
    lines.push("-".repeat(55));
    for (const t of data.foundations) {
      lines.push(`[${t.type}] ${t.content}`);
      if (t.context) lines.push(`  why: ${t.context}`);
      const tags = formatTags(t.tags);
      if (tags) lines.push(`  ${tags} | ${t.confidence} | ${relativeTime(t.created_at)}`);
    }
    lines.push("");
  }

  // Section 2: Team Updates
  if (data.hasTeam) {
    if (data.teamUpdates.length > 0) {
      lines.push(`TEAM UPDATES (${windowLabel(data.teamWindow)}, ${data.teamUpdates.length} traces)`);
      lines.push("-".repeat(55));
      for (const t of data.teamUpdates) {
        const by = t.author_name || t.author.slice(0, 8);
        lines.push(`[${t.type}] ${t.content}  ${relativeTime(t.created_at)}`);
        if (t.context) lines.push(`  ${t.context}`);
        lines.push(`  by: ${by}`);
      }
      lines.push("");
    } else {
      lines.push("TEAM UPDATES");
      lines.push("-".repeat(55));
      lines.push("  No team traces found (searched last 30d)");
      lines.push("");
    }
  }

  // Section 3: Your Progress
  if (data.yourProgress.length > 0) {
    lines.push(`YOUR PROGRESS (${windowLabel(data.yourWindow)}, ${data.yourProgress.length} traces)`);
    lines.push("-".repeat(55));
    for (const t of data.yourProgress) {
      lines.push(`[${t.type}] ${t.content}  ${relativeTime(t.created_at)}`);
      if (t.context) lines.push(`  ${t.context}`);
    }
    lines.push("");
  } else {
    lines.push("YOUR PROGRESS");
    lines.push("-".repeat(55));
    lines.push("  No recent traces found (searched last 7d)");
    lines.push("");
  }

  // Cross-branch activity
  if (data.crossBranch.length > 0 && data.currentBranch) {
    // Group by branch
    const byBranch = new Map<string, typeof data.crossBranch>();
    for (const t of data.crossBranch) {
      const branch = t.tags.find(s => s.startsWith("branch:")) ?? "branch:unknown";
      const branchName = branch.replace("branch:", "");
      if (!byBranch.has(branchName)) byBranch.set(branchName, []);
      byBranch.get(branchName)!.push(t);
    }

    lines.push(`OTHER BRANCHES (${data.crossBranch.length} traces across ${byBranch.size} branches)`);
    lines.push("-".repeat(55));
    for (const [branch, traces] of byBranch) {
      lines.push(`  ${branch}:`);
      for (const t of traces.slice(0, 3)) {
        lines.push(`    [${t.type}] ${t.content}  ${relativeTime(t.created_at)}`);
      }
      if (traces.length > 3) {
        lines.push(`    ... and ${traces.length - 3} more`);
      }
    }
    lines.push("");
  }

  // Asymmetry warning
  if (data.asymmetryWarning) {
    lines.push("!! INFO ASYMMETRY");
    lines.push("-".repeat(55));
    lines.push(`  ${data.asymmetryWarning}`);
    lines.push("");
  }

  // Section 4: Open Plans
  if (data.openPlans.length > 0) {
    lines.push(`OPEN PLANS (${data.openPlans.length} pending)`);
    lines.push("-".repeat(55));
    for (const t of data.openPlans) {
      const tags = formatTags(t.tags);
      lines.push(`  ${t.content}  [${tags}] ${relativeTime(t.created_at)}`);
    }
    lines.push("");
  }

  // Stale knowledge warning
  if (data.staleCount > 0) {
    lines.push(`STALE KNOWLEDGE (${data.staleCount} traces need review)`);
    lines.push("-".repeat(55));
    lines.push("  Run trapic_decay() to review and confirm or deprecate.");
    lines.push("");
  }

  // Active Topics
  if (data.topics.length > 0) {
    lines.push(`ACTIVE TOPICS (${data.topics.length})`);
    lines.push("-".repeat(55));
    for (const topic of data.topics) {
      lines.push(`  ${topic.summary} (${topic.trace_count} traces, ${relativeTime(topic.latest_at)})`);
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
