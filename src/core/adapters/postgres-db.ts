/**
 * PostgreSQL Database Adapter
 *
 * Implements DbAdapter using pg (node-postgres) for production deployments.
 * Uses tsvector/tsquery for full-text search. Supports connection pooling.
 *
 * Usage:
 *   const db = await PostgresDbAdapter.create({
 *     host: "localhost", port: 5432,
 *     user: "trapic", password: "secret", database: "trapic"
 *   });
 */
import pg from "pg";
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

const { Pool } = pg;

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

export interface PostgresConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max?: number; // pool size
}

export class PostgresDbAdapter implements DbAdapter {
  private pool: pg.Pool;

  private constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  static async create(config: PostgresConfig): Promise<PostgresDbAdapter> {
    const pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: config.max ?? 10,
    });
    const adapter = new PostgresDbAdapter(pool);
    await adapter.initSchema();
    return adapter;
  }

  private async initSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS traces (
        id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
        content TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'deprecated')),
        type TEXT NOT NULL DEFAULT 'decision' CHECK (type IN ('decision', 'fact', 'convention', 'state', 'preference')),
        tags JSONB NOT NULL DEFAULT '[]',
        confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
        author TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        superseded_by UUID,
        decay_score DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        flagged_for_review BOOLEAN NOT NULL DEFAULT FALSE,
        last_reviewed_at TIMESTAMPTZ,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TIMESTAMPTZ,
        search_vec TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(content, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(context, '')), 'B')
        ) STORED
      )
    `);

    // Indexes
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_traces_author ON traces(author)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_traces_type ON traces(type)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_traces_tags ON traces USING GIN(tags)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_traces_search ON traces USING GIN(search_vec)`);

    await this.pool.query(`ALTER TABLE traces ADD COLUMN IF NOT EXISTS caused_by UUID[] NOT NULL DEFAULT '{}'`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_traces_caused_by ON traces USING GIN(caused_by)`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        api_key_prefix TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        UNIQUE(team_id, user_id)
      )
    `);
  }

  private parseTags(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return []; }
    }
    return [];
  }

  private toTrace(row: pg.QueryResultRow): Trace {
    return {
      id: row.id,
      content: row.content,
      context: row.context ?? null,
      status: row.status,
      type: row.type,
      tags: this.parseTags(row.tags),
      confidence: row.confidence,
      author: row.author,
      author_name: row.author_name ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at ?? row.created_at).toISOString(),
      flagged_for_review: row.flagged_for_review === true,
      superseded_by: row.superseded_by ?? null,
      caused_by: (row.caused_by as string[]) ?? [],
    };
  }

  // ── Trace CRUD ──

  async insertTrace(trace: TraceInsert): Promise<{ id: string } | null> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO traces (id, content, context, type, author, tags, confidence, caused_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, trace.content, trace.context ?? null, trace.type ?? "decision", trace.author, JSON.stringify(trace.tags), trace.confidence, trace.caused_by ?? []]
    );
    return { id };
  }

  async getTraceFull(traceId: string, authorIds: string[], callerId?: string | null): Promise<Trace | null> {
    if (authorIds.length === 0) return null;
    const placeholders = authorIds.map((_, i) => `$${i + 2}`).join(",");
    const { rows } = await this.pool.query(
      `SELECT t.*, u.name AS author_name FROM traces t LEFT JOIN users u ON u.id = t.author WHERE t.id = $1 AND t.author IN (${placeholders})`,
      [traceId, ...authorIds]
    );
    if (rows.length === 0) return null;
    const trace = this.toTrace(rows[0]);
    if (trace.tags.some(t => t.startsWith("private:")) && trace.author !== callerId) return null;
    return trace;
  }

  async updateTrace(traceId: string, authorId: string, update: TraceUpdate): Promise<Trace | null> {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    let idx = 1;

    if (update.content !== undefined) { sets.push(`content = $${idx++}`); values.push(update.content); }
    if (update.context !== undefined) { sets.push(`context = $${idx++}`); values.push(update.context); }
    if (update.status !== undefined) { sets.push(`status = $${idx++}`); values.push(update.status); }
    if (update.superseded_by !== undefined) {
      sets.push(`superseded_by = $${idx++}`); values.push(update.superseded_by ?? null);
      sets.push("status = 'superseded'");
    }
    if (update.tags !== undefined) { sets.push(`tags = $${idx++}`); values.push(JSON.stringify(update.tags)); }
    if (update.confidence !== undefined) { sets.push(`confidence = $${idx++}`); values.push(update.confidence); }

    if (sets.length === 0) return null;

    sets.push("updated_at = NOW()");
    values.push(traceId, authorId);

    await this.pool.query(
      `UPDATE traces SET ${sets.join(", ")} WHERE id = $${idx++} AND author = $${idx}`,
      values
    );

    return this.getTraceFull(traceId, [authorId], authorId);
  }

  async filterTraces(params: FilterParams): Promise<Trace[]> {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    let idx = 1;

    if (params.status) {
      conditions.push(`status = $${idx++}`);
      values.push(params.status);
    }
    if (params.author_ids.length > 0) {
      const ph = params.author_ids.map(() => `$${idx++}`).join(",");
      conditions.push(`author IN (${ph})`);
      values.push(...params.author_ids);
    }
    if (params.types && params.types.length > 0) {
      const ph = params.types.map(() => `$${idx++}`).join(",");
      conditions.push(`type IN (${ph})`);
      values.push(...params.types);
    }
    if (params.time_days) {
      const days = Math.floor(Math.abs(Number(params.time_days)));
      if (days > 0) {
        conditions.push(`created_at >= NOW() - $${idx++}::interval`);
        values.push(`${days} days`);
      }
    }
    if (params.exclude_stale) {
      conditions.push("flagged_for_review = FALSE");
    }

    const { scope: scopeTags, filter: filterTags } = splitTags(params.tags ?? []);
    const limit = params.limit ?? 50;
    const queryText = params.query?.trim() || null;

    // FTS: use tsvector for keyword search
    let ftsRankExpr = "0::float AS fts_rank";
    let queryParamIdx: number | null = null;
    if (queryText) {
      queryParamIdx = idx++;
      values.push(queryText);
      ftsRankExpr = `ts_rank(search_vec, plainto_tsquery('simple', $${queryParamIdx})) AS fts_rank`;
      // Query only (no tags): use FTS as hard filter for efficiency
      if (filterTags.length === 0) {
        conditions.push(`search_vec @@ plainto_tsquery('simple', $${queryParamIdx})`);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT traces.*, u.name AS author_name, ${ftsRankExpr} FROM traces LEFT JOIN users u ON u.id = traces.author ${where} ORDER BY created_at DESC LIMIT $${idx}`,
      [...values, limit * 3]
    );

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

      // ts_rank returns 0-1 range, scale to match tag scoring range
      const textScore = queryText ? Math.min(5, (row.fts_rank as number) * 10) : 0;

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
    if (traceIds.length === 0) return;
    const ph = traceIds.map((_, i) => `$${i + 1}`).join(",");
    await this.pool.query(
      `UPDATE traces SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id IN (${ph})`,
      traceIds
    );
  }

  // ── Team access ──

  async getVisibleAuthorIds(userId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT u2.id FROM users u1
       JOIN team_members tm1 ON tm1.user_id = u1.id
       JOIN team_members tm2 ON tm1.team_id = tm2.team_id
       JOIN users u2 ON tm2.user_id = u2.id
       WHERE u1.id = $1`,
      [userId]
    );
    const ids = rows.map((r: pg.QueryResultRow) => r.id as string);
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
    if (params.author_ids.length === 0) return [];
    const ph = params.author_ids.map((_, i) => `$${i + 1}`).join(",");
    const { rows } = await this.pool.query(
      `SELECT * FROM traces WHERE status = 'active' AND author IN (${ph})`,
      params.author_ids
    );

    const results: DecayResult[] = [];
    const now = Date.now();

    for (const row of rows) {
      const trace = this.toTrace(row);

      if (params.scope && params.scope.length > 0) {
        if (!params.scope.every(s => trace.tags.includes(s))) continue;
      }
      if (trace.tags.some(t => t.startsWith("private:")) && trace.author !== params.caller_id) continue;

      const halfLife = HALF_LIVES[trace.type] ?? 90;
      const ageDays = (now - new Date(trace.created_at).getTime()) / 86400000;

      const accessCount = row.access_count ?? 0;
      const boostedAge = ageDays / (1 + accessCount * 0.1);
      const decayScore = Math.pow(2, -boostedAge / halfLife);

      if (decayScore < params.flag_threshold) {
        if (!params.dry_run) {
          await this.pool.query(
            `UPDATE traces SET decay_score = $1, flagged_for_review = TRUE WHERE id = $2`,
            [Math.round(decayScore * 1000) / 1000, trace.id]
          );
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
          last_reviewed_at: row.last_reviewed_at ? new Date(row.last_reviewed_at).toISOString() : null,
        });
      }
    }

    return results;
  }

  async getTraceForReview(traceId: string, authorIds: string[], callerId?: string | null): Promise<{ id: string; author: string; content: string } | null> {
    if (authorIds.length === 0) return null;
    const ph = authorIds.map((_, i) => `$${i + 2}`).join(",");
    const { rows } = await this.pool.query(
      `SELECT id, author, content, tags FROM traces WHERE id = $1 AND author IN (${ph})`,
      [traceId, ...authorIds]
    );
    if (rows.length === 0) return null;
    const tags = this.parseTags(rows[0].tags);
    if (tags.some(t => t.startsWith("private:")) && rows[0].author !== callerId) return null;
    return { id: rows[0].id, author: rows[0].author, content: rows[0].content };
  }

  async confirmStaleTrace(traceId: string, authorIds: string[]): Promise<boolean> {
    if (authorIds.length === 0) return false;
    const ph = authorIds.map((_, i) => `$${i + 2}`).join(",");
    const result = await this.pool.query(
      `UPDATE traces SET last_reviewed_at = NOW(), decay_score = 1.0, flagged_for_review = FALSE
       WHERE id = $1 AND author IN (${ph})`,
      [traceId, ...authorIds]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deprecateStaleTrace(traceId: string, authorIds: string[]): Promise<boolean> {
    if (authorIds.length === 0) return false;
    const ph = authorIds.map((_, i) => `$${i + 2}`).join(",");
    const result = await this.pool.query(
      `UPDATE traces SET status = 'deprecated', flagged_for_review = FALSE
       WHERE id = $1 AND author IN (${ph})`,
      [traceId, ...authorIds]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ── Health ──

  async getKnowledgeHealth(tags: string[], authorIds: string[]): Promise<HealthData | null> {
    if (authorIds.length === 0) return null;
    const ph = authorIds.map((_, i) => `$${i + 1}`).join(",");
    const { rows } = await this.pool.query(
      `SELECT * FROM traces WHERE author IN (${ph})`,
      authorIds
    );

    const { scope: scopeTags } = splitTags(tags);
    const filtered = scopeTags.length > 0
      ? rows.filter((r: pg.QueryResultRow) => scopeTags.every(s => this.parseTags(r.tags).includes(s)))
      : rows;

    const now = Date.now();
    const active = filtered.filter((r: pg.QueryResultRow) => r.status === "active");
    const healthy = active.filter((r: pg.QueryResultRow) => !r.flagged_for_review);
    const stale = active.filter((r: pg.QueryResultRow) => r.flagged_for_review);

    const recent7d = active.filter((r: pg.QueryResultRow) => (now - new Date(r.created_at).getTime()) < 7 * 86400000);
    const recent30d = active.filter((r: pg.QueryResultRow) => (now - new Date(r.created_at).getTime()) < 30 * 86400000);

    const byType: Record<string, number> = {};
    for (const r of active) {
      byType[r.type] = (byType[r.type] ?? 0) + 1;
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

  async findCandidateContexts(_scope: string[], _authorIds: string[]): Promise<ContextCandidate[]> {
    return [];
  }

  // ── Users ──

  private static generateApiKey(): string {
    return "sk-" + randomBytes(32).toString("hex");
  }

  private toUser(row: pg.QueryResultRow, plaintextKey?: string): User {
    return {
      id: row.id,
      name: row.name,
      api_key: plaintextKey ?? `${row.api_key_prefix}${"*".repeat(16)}`,
      role: row.role,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  async listUsers(): Promise<User[]> {
    const { rows } = await this.pool.query("SELECT * FROM users ORDER BY created_at DESC");
    return rows.map((r: pg.QueryResultRow) => this.toUser(r));
  }

  async getUserByApiKey(apiKey: string): Promise<User | null> {
    const hash = hashApiKey(apiKey);
    const { rows } = await this.pool.query("SELECT * FROM users WHERE api_key_hash = $1", [hash]);
    return rows.length > 0 ? this.toUser(rows[0]) : null;
  }

  async insertUser(name: string, role: string): Promise<User> {
    const id = randomUUID();
    const apiKey = PostgresDbAdapter.generateApiKey();
    const hash = hashApiKey(apiKey);
    const prefix = apiKey.slice(0, 7);
    await this.pool.query(
      "INSERT INTO users (id, name, api_key_hash, api_key_prefix, role) VALUES ($1, $2, $3, $4, $5)",
      [id, name, hash, prefix, role]
    );
    const { rows } = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return this.toUser(rows[0], apiKey);
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM users WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async regenerateApiKey(id: string): Promise<User | null> {
    const apiKey = PostgresDbAdapter.generateApiKey();
    const hash = hashApiKey(apiKey);
    const prefix = apiKey.slice(0, 7);
    const result = await this.pool.query("UPDATE users SET api_key_hash = $1, api_key_prefix = $2 WHERE id = $3", [hash, prefix, id]);
    if ((result.rowCount ?? 0) === 0) return null;
    const { rows } = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return this.toUser(rows[0], apiKey);
  }

  async userCount(): Promise<number> {
    const { rows } = await this.pool.query("SELECT COUNT(*) as cnt FROM users");
    return parseInt(rows[0].cnt, 10);
  }

  // ── Teams ──

  async listTeams(): Promise<Team[]> {
    const { rows } = await this.pool.query("SELECT * FROM teams ORDER BY created_at DESC");
    return rows.map((r: pg.QueryResultRow) => ({ id: r.id, name: r.name, created_at: new Date(r.created_at).toISOString() }));
  }

  async insertTeam(name: string): Promise<Team> {
    const id = randomUUID();
    await this.pool.query("INSERT INTO teams (id, name) VALUES ($1, $2)", [id, name]);
    const { rows } = await this.pool.query("SELECT * FROM teams WHERE id = $1", [id]);
    return { id: rows[0].id, name: rows[0].name, created_at: new Date(rows[0].created_at).toISOString() };
  }

  async deleteTeam(id: string): Promise<boolean> {
    // team_members has ON DELETE CASCADE, so just delete the team
    const result = await this.pool.query("DELETE FROM teams WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async listTeamMembers(teamId: string): Promise<TeamMember[]> {
    const { rows } = await this.pool.query(
      `SELECT tm.id, tm.team_id, tm.user_id, tm.role, u.name as user_name
       FROM team_members tm LEFT JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1`, [teamId]
    );
    return rows.map((r: pg.QueryResultRow) => ({
      id: r.id, team_id: r.team_id, user_id: r.user_id,
      role: r.role, user_name: r.user_name ?? undefined,
    }));
  }

  async addTeamMember(teamId: string, userId: string, role: string = "member"): Promise<TeamMember> {
    const id = randomUUID();
    await this.pool.query(
      "INSERT INTO team_members (id, team_id, user_id, role) VALUES ($1, $2, $3, $4)",
      [id, teamId, userId, role]
    );
    return { id, team_id: teamId, user_id: userId, role };
  }

  async removeTeamMember(teamId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
