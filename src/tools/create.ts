import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DbAdapter } from "../core/db-adapter.js";
import { hooks } from "../core/hooks.js";

const VALID_TYPES = ["decision", "fact", "convention", "state", "preference"];

/** Jaccard similarity on word tokens (case-insensitive) */
function jaccard(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const DEDUP_THRESHOLD = 0.6;
const DEDUP_SEARCH_DAYS = 30;
const DEDUP_SEARCH_LIMIT = 20;

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
        "What was decided/discovered. Can be a single sentence or a full markdown document (tables, code blocks, lists)."
      ),
      context: z.string().max(50000).optional().describe(
        "Why this matters — the causal explanation. Supports markdown."
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
      visibility: z.enum(["public", "private", "team"]).default("public").describe(
        "Visibility: public (all team members), private (author only), team (specific teams). " +
        "Traces with private: tags are auto-set to private. Default: public."
      ),
      team_id: z.string().uuid().optional().describe(
        "Team ID from session start (trapic-recall or trapic-my-teams). " +
        "AI should remember this from the session and pass it automatically. " +
        "If omitted: 1 team = auto-fill, 2+ teams = returns error asking to pick."
      ),
    },
    async (params) => {
      try {
        if (!userId) {
          return { content: [{ type: "text" as const, text: "Error: Authentication required." }] };
        }

        // Detect old-style usage and warn
        const warnings: string[] = [];

        // Old: type in tags instead of type param
        const typeInTags = params.tags.find(t => VALID_TYPES.includes(t));
        if (typeInTags && params.type === "decision") {
          // User likely using old format where type was first tag
          warnings.push(`UPGRADE: Use the "type" parameter instead of putting "${typeInTags}" in tags. Your Trapic plugin may be outdated — update via: claude plugin update trapic`);
        }

        // Old: scope parameter (no longer exists, but tags might be missing project:)
        const hasProject = params.tags.some(t => t.startsWith("project:"));
        if (!hasProject) {
          return { content: [{ type: "text" as const, text: "Error: Missing project: tag. Every trace MUST include a project: tag (e.g. project:myapp).\n\nIf you're seeing this, your Trapic plugin may be outdated. Update: claude plugin update trapic" }] };
        }

        // Non-English content detection
        const hasNonLatin = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(params.content);
        if (hasNonLatin) {
          warnings.push("UPGRADE: Trace content should be in English for better searchability. Your Trapic plugin may need updating: claude plugin update trapic");
        }

        // Build final tags: type + user tags (deduplicated)
        const finalTags = [params.type, ...params.tags];
        const seen = new Set<string>();
        const deduped = finalTags.filter(t => {
          if (seen.has(t)) return false;
          seen.add(t);
          // Remove old-style type tags from user input (they now use the type param)
          if (VALID_TYPES.includes(t) && t !== params.type) return false;
          return true;
        });

        const quota = await hooks.quota(userId);
        if (!quota.allowed) {
          return { content: [{ type: "text" as const, text: `Monthly trace limit reached (${quota.used}/${quota.limit}).` }] };
        }

        // Jaccard dedup: check for similar traces before creating
        const projectTag = deduped.find(t => t.startsWith("project:"));
        if (projectTag) {
          const existing = await db.filterTraces({
            tags: [projectTag, params.type],
            status: "active",
            author_ids: [userId],
            time_days: DEDUP_SEARCH_DAYS,
            limit: DEDUP_SEARCH_LIMIT,
            caller_id: userId,
          });
          for (const trace of existing) {
            const sim = jaccard(params.content, trace.content);
            if (sim >= DEDUP_THRESHOLD) {
              // Supersede old trace instead of creating duplicate
              await db.updateTrace(trace.id, userId, { status: "superseded" });
              warnings.push(`Superseded similar trace ${trace.id.slice(0, 8)} (${(sim * 100).toFixed(0)}% overlap)`);
              break; // Only supersede the most relevant one
            }
          }
        }

        // Team resolution for visible_to_teams
        let visibleToTeams: string[] | undefined;
        if (params.team_id) {
          visibleToTeams = [params.team_id];
        } else {
          const userTeams = await db.getUserTeams(userId);
          if (userTeams.length === 1) {
            visibleToTeams = [userTeams[0].id];
          } else if (userTeams.length > 1) {
            const teamLines = userTeams.map(t => `- ${t.name} (${t.id})`).join("\n");
            return { content: [{ type: "text" as const, text: `Multiple teams found. Please pass team_id:\n${teamLines}` }] };
          }
        }

        const result = await db.insertTrace({
          content: params.content,
          context: params.context ?? null,
          type: params.type,
          author: userId,
          tags: deduped,
          confidence: params.confidence,
          caused_by: params.caused_by.length > 0 ? params.caused_by : undefined,
          visibility: visibleToTeams ? "team" : params.visibility,
          visible_to_teams: visibleToTeams,
        });

        if (!result) {
          return { content: [{ type: "text" as const, text: "Error creating trace." }] };
        }

        hooks.audit(userId, "trace.create", "trace", result.id, { tags: deduped });

        const response: Record<string, unknown> = { id: result.id, type: params.type, status: "created" };
        if (warnings.length > 0) response.warnings = warnings;

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    }
  );
}
