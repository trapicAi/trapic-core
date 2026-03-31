/**
 * SQLite Database Adapter
 *
 * Implements DbAdapter using better-sqlite3 for local/Docker deployments.
 * No encryption, no RPC — pure SQL. Uses FTS5 for full-text search.
 *
 * Usage:
 *   const db = new SqliteDbAdapter("./trapic.db");
 */
import Database from "better-sqlite3";
import {
  DbAdapter,
  Trace,
  TraceInsert,
  TraceUpdate,
  FilterParams,
  DecayResult,
  HealthData,
  ContextCandidate,
  User,
  Team,
  TeamMember,
} from "../db-adapter.js";
import { splitTags } from "../tag-utils.js";
import { randomUUID, randomBytes, createHash } from "crypto";

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

const HALF_LIVES: Record<string, number> = {
  state: 30,
  decision: 90,
  convention: 180,
  preference: 180,
  fact: 365,
};

export class SqliteDbAdapter implements DbAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
        content TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'deprecated')),
        type TEXT NOT NULL DEFAULT 'decision' CHECK (type IN ('decision', 'fact', 'convention', 'state', 'preference')),
        tags TEXT NOT NULL DEFAULT '[]',
        confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
        author TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        superseded_by TEXT,
        decay_score REAL NOT NULL DEFAULT 1.0,
        flagged_for_review INTEGER NOT NULL DEFAULT 0,
        last_reviewed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        api_key_prefix TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS team_members (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        UNIQUE(team_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_traces_author ON traces(author);
      CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
      CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at);
      CREATE INDEX IF NOT EXISTS idx_traces_type ON traces(type);

      CREATE VIRTUAL TABLE IF NOT EXISTS traces_fts USING fts5(
        content, context, content=traces, content_rowid=rowid
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS traces_ai AFTER INSERT ON traces BEGIN
        INSERT INTO traces_fts(rowid, content, context) VALUES (new.rowid, new.content, new.context);
      END;
      CREATE TRIGGER IF NOT EXISTS traces_ad AFTER DELETE ON traces BEGIN
        INSERT INTO traces_fts(traces_fts, rowid, content, context) VALUES ('delete', old.rowid, old.content, old.context);
      END;
      CREATE TRIGGER IF NOT EXISTS traces_au AFTER UPDATE ON traces BEGIN
        INSERT INTO traces_fts(traces_fts, rowid, content, context) VALUES ('delete', old.rowid, old.content, old.context);
        INSERT INTO traces_fts(rowid, content, context) VALUES (new.rowid, new.content, new.context);
      END;
    `);

    // Migration: add caused_by column if missing
    try { this.db.exec("ALTER TABLE traces ADD COLUMN caused_by TEXT NOT NULL DEFAULT '[]'"); } catch { /* already exists */ }
  }

  private parseTags(raw: string): string[] {
    try { return JSON.parse(raw); } catch { return []; }
  }

  private toTrace(row: Record<string, unknown>): Trace {
    return {
      id: row.id as string,
      content: row.content as string,
      context: (row.context as string) ?? null,
      status: row.status as string,
      type: row.type as string,
      tags: this.parseTags(row.tags as string),
      confidence: row.confidence as string,
      author: row.author as string,
      author_name: (row.author_name as string) ?? undefined,
      created_at: row.created_at as string,
      updated_at: (row.updated_at as string) ?? row.created_at as string,
      flagged_for_review: (row.flagged_for_review as number) === 1,
      superseded_by: (row.superseded_by as string) ?? null,
      caused_by: this.parseTags(row.caused_by as string ?? "[]"),
    };
  }

  // ── Trace CRUD ──

  async insertTrace(trace: TraceInsert): Promise<{ id: string } | null> {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO traces (id, content, context, type, author, tags, confidence, caused_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, trace.content, trace.context ?? null, trace.type ?? "decision",
      trace.author, JSON.stringify(trace.tags), trace.confidence, JSON.stringify(trace.caused_by ?? []));
    return { id };
  }

  async getTraceFull(traceId: string, authorIds: string[], callerId?: string | null): Promise<Trace | null> {
    const placeholders = authorIds.map(() => "?").join(",");
    const row = this.db.prepare(`
      SELECT t.*, u.name AS author_name FROM traces t
      LEFT JOIN users u ON u.id = t.author
      WHERE t.id = ? AND t.author IN (${placeholders})
    `).get(traceId, ...authorIds) as Record<string, unknown> | undefined;
    if (!row) return null;
    const trace = this.toTrace(row);
    if (trace.tags.some(t => t.startsWith("private:")) && trace.author !== callerId) return null;
    return trace;
  }

  async updateTrace(traceId: string, authorId: string, update: TraceUpdate): Promise<Trace | null> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (update.content !== undefined) { sets.push("content = ?"); values.push(update.content); }
    if (update.context !== undefined) { sets.push("context = ?"); values.push(update.context); }
    if (update.status !== undefined) { sets.push("status = ?"); values.push(update.status); }
    if (update.superseded_by !== undefined) {
      sets.push("superseded_by = ?"); values.push(update.superseded_by);
      sets.push("status = 'superseded'");
    }
    if (update.tags !== undefined) { sets.push("tags = ?"); values.push(JSON.stringify(update.tags)); }
    if (update.confidence !== undefined) { sets.push("confidence = ?"); values.push(update.confidence); }

    if (sets.length === 0) return null;

    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");

    values.push(traceId, authorId);
    this.db.prepare(`UPDATE traces SET ${sets.join(", ")} WHERE id = ? AND author = ?`).run(...values);

    return this.getTraceFull(traceId, [authorId], authorId);
  }

  async filterTraces(params: FilterParams): Promise<Trace[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.status) {
      conditions.push("t.status = ?");
      values.push(params.status);
    }
    if (params.author_ids.length > 0) {
      const ph = params.author_ids.map(() => "?").join(",");
      conditions.push(`t.author IN (${ph})`);
      values.push(...params.author_ids);
    }
    if (params.types && params.types.length > 0) {
      const ph = params.types.map(() => "?").join(",");
      conditions.push(`t.type IN (${ph})`);
      values.push(...params.types);
    }
    if (params.time_days) {
      const days = Math.floor(Math.abs(Number(params.time_days)));
      if (days > 0) {
        conditions.push("t.created_at >= datetime('now', ?)");
        values.push(`-${days} days`);
      }
    }
    if (params.exclude_stale) {
      conditions.push("t.flagged_for_review = 0");
    }

    const { scope: scopeTags, filter: filterTags } = splitTags(params.tags ?? []);
    const limit = params.limit ?? 50;
    const queryText = params.query?.trim() || null;

    // Step 1: Build FTS rank map when query exists
    const ftsRanks = new Map<number, number>();
    if (queryText) {
      const ftsTerms = queryText.split(/\s+/).filter(Boolean)
        .map(w => '"' + w.replace(/"/g, '""') + '"').join(" OR ");
      try {
        const ftsRows = this.db.prepare(
          "SELECT rowid, rank FROM traces_fts WHERE traces_fts MATCH ?"
        ).all(ftsTerms) as { rowid: number; rank: number }[];
        for (const r of ftsRows) ftsRanks.set(r.rowid, r.rank);
      } catch { /* invalid FTS query, fall through with empty map */ }
    }

    // Step 2: Fetch candidates
    let rows: Record<string, unknown>[];
    const extraWhere = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
    const baseWhere = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    if (queryText && filterTags.length === 0 && ftsRanks.size > 0) {
      // Query only (no tags): restrict to FTS matches for efficiency
      const ftsRowIds = [...ftsRanks.keys()];
      const idsPlaceholder = ftsRowIds.map(() => "?").join(",");
      rows = this.db.prepare(`
        SELECT t.rowid AS _rowid, t.*, u.name AS author_name FROM traces t LEFT JOIN users u ON u.id = t.author
        WHERE t.rowid IN (${idsPlaceholder}) ${extraWhere}
        ORDER BY t.created_at DESC LIMIT ?
      `).all(...ftsRowIds, ...values, limit * 3) as Record<string, unknown>[];
    } else {
      // Tags present or no query: fetch recent candidates
      rows = this.db.prepare(
        `SELECT t.rowid AS _rowid, t.*, u.name AS author_name FROM traces t LEFT JOIN users u ON u.id = t.author ${baseWhere} ORDER BY t.created_at DESC LIMIT ?`
      ).all(...values, limit * 3) as Record<string, unknown>[];
    }

    // Step 3: Score using FTS rank + tag overlap
    const scored: { trace: Trace; score: number }[] = [];

    for (const row of rows) {
      const trace = this.toTrace(row);
      if (scopeTags.length > 0 && !scopeTags.every(s => trace.tags.includes(s))) continue;
      if (trace.tags.some(t => t.startsWith("private:")) && trace.author !== params.caller_id) continue;

      let tagScore = 0;
      if (filterTags.length > 0) {
        const matchCount = filterTags.filter(t => trace.tags.includes(t)).length;
        tagScore = matchCount / filterTags.length;
      }

      // FTS5 rank is negative (more negative = better match), normalize to 0-5
      const ftsRank = ftsRanks.get(row._rowid as number);
      const textScore = ftsRank != null ? Math.min(5, Math.max(0.5, -ftsRank)) : 0;

      if ((filterTags.length > 0 || queryText) && tagScore === 0 && textScore === 0) continue;

      const ageDays = (Date.now() - new Date(trace.created_at).getTime()) / 86400000;
      const recency = Math.max(0, 1 - ageDays / 365);
      const score = (tagScore * 3) + textScore + recency * 0.5 + (tagScore > 0 ? 1 : 0);

      scored.push({ trace, score });
    }

    scored.sort((a, b) => b.score !== a.score ? b.score - a.score
      : new Date(b.trace.created_at).getTime() - new Date(a.trace.created_at).getTime());

    return scored.slice(0, limit).map(s => s.trace);
  }

  async incrementAccessCount(traceIds: string[]): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE traces SET access_count = access_count + 1, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `);
    for (const id of traceIds) stmt.run(id);
  }

  // ── Team access ──

  async getVisibleAuthorIds(userId: string): Promise<string[]> {
    // userId is now the user's UUID (not name)
    const rows = this.db.prepare(`
      SELECT DISTINCT u2.id FROM users u1
      JOIN team_members tm1 ON tm1.user_id = u1.id
      JOIN team_members tm2 ON tm1.team_id = tm2.team_id
      JOIN users u2 ON tm2.user_id = u2.id
      WHERE u1.id = ?
    `).all(userId) as { id: string }[];
    const ids = rows.map(r => r.id);
    if (!ids.includes(userId)) ids.push(userId);
    return ids;
  }

  // ── Decay ──

  async calculateDecayScores(params: {
    author_ids: string[];
    flag_threshold: number;
    dry_run: boolean;
    scope?: string[];
    caller_id?: string | null;
  }): Promise<DecayResult[]> {
    const ph = params.author_ids.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT * FROM traces WHERE status = 'active' AND author IN (${ph})
    `).all(...params.author_ids) as Record<string, unknown>[];

    const results: DecayResult[] = [];
    const now = Date.now();

    for (const row of rows) {
      const trace = this.toTrace(row);

      // Scope filter (scope tags use AND logic)
      if (params.scope && params.scope.length > 0) {
        if (!params.scope.every(s => trace.tags.includes(s))) continue;
      }
      // Private tag filter
      if (trace.tags.some(t => t.startsWith("private:")) && trace.author !== params.caller_id) continue;

      const halfLife = HALF_LIVES[trace.type] ?? 90;
      const ageDays = (now - new Date(trace.created_at).getTime()) / 86400000;

      // Exponential decay: score = 2^(-age/halfLife)
      // Access boost: reduce effective age
      const accessCount = (row.access_count as number) ?? 0;
      const boostedAge = ageDays / (1 + accessCount * 0.1);
      const decayScore = Math.pow(2, -boostedAge / halfLife);

      if (decayScore < params.flag_threshold) {
        if (!params.dry_run) {
          this.db.prepare(`
            UPDATE traces SET decay_score = ?, flagged_for_review = 1 WHERE id = ?
          `).run(Math.round(decayScore * 1000) / 1000, trace.id);
        }

        results.push({
          id: trace.id,
          content: trace.content,
          type: trace.type,
          tags: trace.tags,
          confidence: trace.confidence,
          age_days: Math.round(ageDays),
          decay_score: Math.round(decayScore * 1000) / 1000,
          half_life_days: halfLife,
          last_reviewed_at: (row.last_reviewed_at as string) ?? null,
        });
      }
    }

    return results;
  }

  async getTraceForReview(traceId: string, authorIds: string[], callerId?: string | null): Promise<{ id: string; author: string; content: string } | null> {
    const ph = authorIds.map(() => "?").join(",");
    const row = this.db.prepare(`
      SELECT id, author, content, tags FROM traces WHERE id = ? AND author IN (${ph})
    `).get(traceId, ...authorIds) as { id: string; author: string; content: string; tags: string } | undefined;
    if (!row) return null;
    const tags = this.parseTags(row.tags);
    if (tags.some(t => t.startsWith("private:")) && row.author !== callerId) return null;
    return { id: row.id, author: row.author, content: row.content };
  }

  async confirmStaleTrace(traceId: string, authorIds: string[]): Promise<boolean> {
    const ph = authorIds.map(() => "?").join(",");
    const result = this.db.prepare(`
      UPDATE traces SET last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        decay_score = 1.0, flagged_for_review = 0
      WHERE id = ? AND author IN (${ph})
    `).run(traceId, ...authorIds);
    return result.changes > 0;
  }

  async deprecateStaleTrace(traceId: string, authorIds: string[]): Promise<boolean> {
    const ph = authorIds.map(() => "?").join(",");
    const result = this.db.prepare(`
      UPDATE traces SET status = 'deprecated', flagged_for_review = 0
      WHERE id = ? AND author IN (${ph})
    `).run(traceId, ...authorIds);
    return result.changes > 0;
  }

  // ── Health ──

  async getKnowledgeHealth(tags: string[], authorIds: string[]): Promise<HealthData | null> {
    const ph = authorIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM traces WHERE author IN (${ph})`).all(...authorIds) as Record<string, unknown>[];

    const { scope: scopeTags } = splitTags(tags);
    const filtered = scopeTags.length > 0
      ? rows.filter(r => scopeTags.every(s => this.parseTags(r.tags as string).includes(s)))
      : rows;

    const now = Date.now();
    const active = filtered.filter(r => r.status === "active");
    const healthy = active.filter(r => !(r.flagged_for_review as number));
    const stale = active.filter(r => r.flagged_for_review as number);
    const deprecated = filtered.filter(r => r.status === "deprecated");
    const superseded = filtered.filter(r => r.status === "superseded");

    const recent7d = active.filter(r => (now - new Date(r.created_at as string).getTime()) < 7 * 86400000);
    const recent30d = active.filter(r => (now - new Date(r.created_at as string).getTime()) < 30 * 86400000);

    const byType: Record<string, number> = {};
    for (const r of active) {
      const t = r.type as string;
      byType[t] = (byType[t] ?? 0) + 1;
    }

    return {
      total_traces: filtered.length,
      active_traces: active.length,
      stale_traces: stale.length,
      health_pct: active.length > 0 ? Math.round(healthy.length / active.length * 100) : 100,
      by_type: byType,
      by_confidence: {},
      recent_7d: recent7d.length,
      recent_30d: recent30d.length,
    };
  }

  // ── Context (simplified for SQLite) ──

  async findCandidateContexts(_scope: string[], _authorIds: string[]): Promise<ContextCandidate[]> {
    return [];
  }

  // ── Users ──

  private static generateApiKey(): string {
    return "sk-" + randomBytes(32).toString("hex");
  }

  private toUser(row: Record<string, unknown>, plaintextKey?: string): User {
    return {
      id: row.id as string,
      name: row.name as string,
      api_key: plaintextKey ?? `${row.api_key_prefix as string}${"*".repeat(16)}`,
      role: row.role as string,
      created_at: row.created_at as string,
    };
  }

  async listUsers(): Promise<User[]> {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY created_at DESC").all() as Record<string, unknown>[];
    return rows.map(r => this.toUser(r));
  }

  async getUserByApiKey(apiKey: string): Promise<User | null> {
    const hash = hashApiKey(apiKey);
    const row = this.db.prepare("SELECT * FROM users WHERE api_key_hash = ?").get(hash) as Record<string, unknown> | undefined;
    return row ? this.toUser(row) : null;
  }

  async insertUser(name: string, role: string): Promise<User> {
    const id = randomUUID();
    const apiKey = SqliteDbAdapter.generateApiKey();
    const hash = hashApiKey(apiKey);
    const prefix = apiKey.slice(0, 7); // "sk-xxxx"
    this.db.prepare("INSERT INTO users (id, name, api_key_hash, api_key_prefix, role) VALUES (?, ?, ?, ?, ?)").run(id, name, hash, prefix, role);
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown>;
    return this.toUser(row, apiKey);
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return result.changes > 0;
  }

  async regenerateApiKey(id: string): Promise<User | null> {
    const apiKey = SqliteDbAdapter.generateApiKey();
    const hash = hashApiKey(apiKey);
    const prefix = apiKey.slice(0, 7);
    const result = this.db.prepare("UPDATE users SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?").run(hash, prefix, id);
    if (result.changes === 0) return null;
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown>;
    return this.toUser(row, apiKey);
  }

  async userCount(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM users").get() as { cnt: number };
    return row.cnt;
  }

  // ── Teams ──

  async listTeams(): Promise<Team[]> {
    const rows = this.db.prepare("SELECT * FROM teams ORDER BY created_at DESC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      created_at: r.created_at as string,
    }));
  }

  async insertTeam(name: string): Promise<Team> {
    const id = randomUUID();
    this.db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run(id, name);
    const row = this.db.prepare("SELECT * FROM teams WHERE id = ?").get(id) as Record<string, unknown>;
    return { id: row.id as string, name: row.name as string, created_at: row.created_at as string };
  }

  async deleteTeam(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM teams WHERE id = ?").run(id);
    return result.changes > 0;
  }

  async listTeamMembers(teamId: string): Promise<TeamMember[]> {
    const rows = this.db.prepare(`
      SELECT tm.id, tm.team_id, tm.user_id, tm.role, u.name as user_name
      FROM team_members tm LEFT JOIN users u ON tm.user_id = u.id
      WHERE tm.team_id = ?
    `).all(teamId) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      team_id: r.team_id as string,
      user_id: r.user_id as string,
      role: r.role as string,
      user_name: r.user_name as string | undefined,
    }));
  }

  async addTeamMember(teamId: string, userId: string, role: string = "member"): Promise<TeamMember> {
    const id = randomUUID();
    this.db.prepare("INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, ?)").run(id, teamId, userId, role);
    return { id, team_id: teamId, user_id: userId, role };
  }

  async removeTeamMember(teamId: string, userId: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").run(teamId, userId);
    return result.changes > 0;
  }
}
