import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DbAdapter } from "../core/db-adapter.js";
import { hooks } from "../core/hooks.js";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface GitCommit {
  hash: string;
  date: string;
  subject: string;
  body: string;
  files_changed: number;
  insertions: number;
  deletions: number;
}

/** Parse git log into structured commits */
function parseGitLog(repoPath: string, maxCommits: number, since?: string): GitCommit[] {
  const format = "%H%n%aI%n%s%n%b%n---END---";
  const args = ["-C", repoPath, "log", `--format=${format}`, "--shortstat", "-n", String(maxCommits)];
  if (since) args.push(`--since=${since}`);

  let logOutput: string;
  try {
    logOutput = execFileSync("git", args, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return [];
  }

  const commits: GitCommit[] = [];
  const blocks = logOutput.split("---END---\n").filter(Boolean);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;

    const hash = lines[0].trim();
    const date = lines[1].trim();
    const subject = lines[2].trim();

    // Body = everything between subject and stat line
    const bodyLines: string[] = [];
    let statsLine = "";
    for (let i = 3; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.match(/^\d+ files? changed/)) {
        statsLine = line;
      } else if (line) {
        bodyLines.push(line);
      }
    }

    // Parse stats
    const filesMatch = statsLine.match(/(\d+) files? changed/);
    const insertMatch = statsLine.match(/(\d+) insertions?/);
    const deleteMatch = statsLine.match(/(\d+) deletions?/);

    commits.push({
      hash,
      date,
      subject,
      body: bodyLines.join("\n"),
      files_changed: filesMatch ? parseInt(filesMatch[1]) : 0,
      insertions: insertMatch ? parseInt(insertMatch[1]) : 0,
      deletions: deleteMatch ? parseInt(deleteMatch[1]) : 0,
    });
  }

  return commits;
}

/** Filter out trivial commits */
function isSignificant(c: GitCommit): boolean {
  const subj = c.subject.toLowerCase();

  // Skip trivial
  if (subj.match(/^(fix typo|typo|formatting|lint|style:|chore\(deps\)|bump|merge branch.*into|wip$)/)) return false;
  if (c.files_changed === 0) return false;
  if (c.files_changed === 1 && c.insertions + c.deletions <= 3) return false;

  return true;
}

/** Infer trace type from commit message */
function inferType(subject: string): string {
  const s = subject.toLowerCase();
  if (s.startsWith("feat:") || s.startsWith("feat(") || s.includes("add ") || s.includes("implement")) return "decision";
  if (s.startsWith("fix:") || s.startsWith("fix(") || s.includes("bug")) return "fact";
  if (s.startsWith("refactor:") || s.startsWith("refactor(")) return "decision";
  if (s.startsWith("docs:")) return "convention";
  if (s.startsWith("test:")) return "convention";
  if (s.startsWith("chore:")) return "state";
  if (s.includes("migrate") || s.includes("switch") || s.includes("replace")) return "decision";
  if (s.includes("convention") || s.includes("pattern") || s.includes("standard")) return "convention";
  return "decision";
}

/** Infer topic tags from commit message and file paths */
function inferTopics(c: GitCommit): string[] {
  const text = `${c.subject} ${c.body}`.toLowerCase();
  const topics = new Set<string>();

  const patterns: [RegExp, string][] = [
    [/auth|login|session|jwt|oauth|token/, "topic:auth"],
    [/api|endpoint|route|rest|graphql|trpc/, "topic:api"],
    [/database|db|sql|postgres|sqlite|migration/, "topic:database"],
    [/test|spec|jest|vitest|cypress/, "topic:testing"],
    [/ci|cd|deploy|docker|github.action|pipeline/, "topic:ci-cd"],
    [/css|style|theme|tailwind|design/, "topic:styling"],
    [/component|ui|button|modal|form/, "topic:ui"],
    [/performance|speed|cache|optimize|latency/, "topic:performance"],
    [/security|xss|csrf|injection|vulnerability/, "topic:security"],
    [/config|env|setting|variable/, "topic:configuration"],
    [/error|exception|catch|handle|fallback/, "topic:error-handling"],
    [/type|typescript|interface|generic/, "topic:typescript"],
    [/react|hook|component|jsx|tsx/, "topic:react"],
    [/node|express|hono|server|middleware/, "topic:backend"],
    [/build|webpack|vite|bundle|esbuild/, "topic:build"],
    [/git|version|branch|merge|release/, "topic:version-control"],
    [/doc|readme|comment|jsdoc/, "topic:documentation"],
    [/dep|package|npm|pnpm|yarn|upgrade/, "topic:dependencies"],
    [/log|monitor|trace|metric|observ/, "topic:observability"],
    [/file|upload|image|asset|storage/, "topic:storage"],
  ];

  for (const [regex, topic] of patterns) {
    if (regex.test(text)) topics.add(topic);
  }

  // Ensure at least 1 topic
  if (topics.size === 0) topics.add("topic:general");

  // Return max 3
  return Array.from(topics).slice(0, 3);
}

export function registerImportGit(server: McpServer, userId: string | null, db: DbAdapter): void {
  server.tool(
    "trapic-import-git",
    "Import knowledge from git history. Analyzes commits and creates traces for significant decisions, " +
    "conventions, and facts. Use to bootstrap a project's knowledge base. " +
    "從 git 歷史匯入知識。分析 commits 並建立 traces。",
    {
      url: z.string().url().refine(u => u.startsWith("https://") || u.startsWith("http://"), "Only HTTP(S) URLs allowed").describe("Git repo URL (HTTPS only)"),
      project: z.string().max(100).regex(/^[a-zA-Z0-9._-]+$/).describe("Project name for tags, e.g. 'my-app'"),
      branch: z.string().max(100).regex(/^[a-zA-Z0-9._\-/]+$/).default("main").describe("Branch to analyze (default: main)"),
      max_commits: z.number().int().min(1).max(500).default(100).describe("Max commits to analyze (default: 100)"),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only commits after this date (YYYY-MM-DD)"),
      dry_run: z.boolean().default(true).describe("Preview only, don't create traces (default: true). 僅預覽，不建立 traces"),
    },
    async (params) => {
      try {
        if (!userId) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        const lines: string[] = [];
        lines.push(`IMPORT GIT (${params.dry_run ? "dry_run" : "creating traces"})`);
        lines.push("=".repeat(55));

        // Clone to temp dir
        const tmpDir = mkdtempSync(join(tmpdir(), "trapic-git-"));
        lines.push(`Cloning ${params.url}...`);

        try {
          execFileSync("git", [
            "clone", `--depth=${params.max_commits + 10}`,
            "--branch", params.branch,
            "--single-branch", params.url, tmpDir,
          ], { encoding: "utf-8", timeout: 60000, stdio: "pipe" });
        } catch (e) {
          rmSync(tmpDir, { recursive: true, force: true });
          return { content: [{ type: "text" as const, text: `Error cloning repo: ${e instanceof Error ? e.message : String(e)}` }] };
        }

        // Ensure temp dir cleanup on any error below
        try {

        // Parse commits
        const allCommits = parseGitLog(tmpDir, params.max_commits, params.since);
        const significant = allCommits.filter(isSignificant);

        lines.push(`Found ${allCommits.length} commits, ${significant.length} significant`);
        lines.push("");

        // Check for already-imported commits
        const existingTraces = await db.filterTraces({
          tags: [`project:${params.project}`],
          author_ids: [userId],
          limit: 500,
          caller_id: userId,
        });
        const existingCommitHashes = new Set<string>();
        for (const t of existingTraces) {
          for (const tag of t.tags) {
            if (tag.startsWith("commit:")) existingCommitHashes.add(tag.slice(7));
          }
        }

        const newCommits = significant.filter(c => !existingCommitHashes.has(c.hash.slice(0, 8)));
        const skipped = significant.length - newCommits.length;
        if (skipped > 0) {
          lines.push(`Skipped ${skipped} already-imported commits`);
        }

        // Process commits
        let created = 0;
        for (const c of newCommits) {
          const type = inferType(c.subject);
          const topics = inferTopics(c);
          const commitTag = `commit:${c.hash.slice(0, 8)}`;

          const content = c.subject.replace(/^(feat|fix|refactor|docs|test|chore)(\(.+?\))?:\s*/i, "").trim();
          const context = c.body || `${c.files_changed} files, +${c.insertions}/-${c.deletions}`;

          const tags = [
            type,
            ...topics,
            `project:${params.project}`,
            `branch:${params.branch}`,
            commitTag,
          ];

          if (params.dry_run) {
            lines.push(`[${type}] ${content}`);
            lines.push(`  ${topics.join(", ")} | ${c.date.slice(0, 10)} | ${commitTag}`);
          } else {
            await db.insertTrace({
              content,
              context,
              author: userId,
              tags,
              confidence: "medium",
            });
            created++;
          }
        }

        lines.push("");
        lines.push("-------------------------------------------------------");
        if (params.dry_run) {
          lines.push(`Preview: ${newCommits.length} traces would be created`);
          lines.push(`Run with dry_run=false to create them.`);
        } else {
          lines.push(`Created ${created} traces for project:${params.project}`);
        }

        hooks.audit(userId, "trace.create", "trace", undefined, {
          action: "import_git",
          url: params.url,
          commits_analyzed: allCommits.length,
          commits_significant: significant.length,
          traces_created: created,
          dry_run: params.dry_run,
        });

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } finally {
          // Always clean up temp dir
          rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
