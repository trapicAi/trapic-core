/**
 * MariaDB/MySQL Database Adapter
 *
 * Implements DbAdapter using mysql2 for production deployments.
 * Supports MariaDB and MySQL. Uses FULLTEXT indexes for search.
 *
 * Usage:
 *   const db = await MariaDbAdapter.create({
 *     host: "localhost", port: 3306,
 *     user: "trapic", password: "secret", database: "trapic"
 *   });
 */
import mysql, { Pool, PoolOptions, RowDataPacket, ResultSetHeader } from "mysql2/promise";
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

export interface MariaDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
}

export class MariaDbAdapter implements DbAdapter {
  private pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  static async create(config: MariaDbConfig): Promise<MariaDbAdapter> {
    const poolOpts: PoolOptions = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit ?? 10,
      charset: "utf8mb4",
    };
    const pool = mysql.createPool(poolOpts);
    const adapter = new MariaDbAdapter(pool);
    await adapter.initSchema();
    return adapter;
  }

  private async initSchema(): Promise<void> {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS traces (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        content TEXT NOT NULL,
        context TEXT,
        status ENUM('active', 'superseded', 'deprecated') NOT NULL DEFAULT 'active',
        type ENUM('decision', 'fact', 'convention', 'state', 'preference') NOT NULL DEFAULT 'decision',
        tags JSON NOT NULL,
        confidence ENUM('high', 'medium', 'low') NOT NULL DEFAULT 'medium',
        author VARCHAR(255) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        superseded_by VARCHAR(36),
        decay_score DOUBLE NOT NULL DEFAULT 1.0,
        flagged_for_review TINYINT(1) NOT NULL DEFAULT 0,
        last_reviewed_at DATETIME(3),
        access_count INT NOT NULL DEFAULT 0,
        last_accessed_at DATETIME(3),
        FULLTEXT INDEX ft_content (content, context),
        INDEX idx_author (author),
        INDEX idx_status (status),
        INDEX idx_created (created_at),
        INDEX idx_type (type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        api_key_hash VARCHAR(64) NOT NULL UNIQUE,
        api_key_prefix VARCHAR(10) NOT NULL DEFAULT '',
        role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS teams (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS team_members (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        team_id VARCHAR(36) NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'member',
        UNIQUE KEY uq_team_user (team_id, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    try { await this.pool.execute("ALTER TABLE traces ADD COLUMN caused_by JSON NOT NULL DEFAULT ('[]')"); } catch { /* already exists */ }
  }

  private parseTags(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return []; }
    }
    return [];
  }

  private formatDate(d: Date | string | null): string | null {
    if (!d) return null;
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toISOString().replace("Z", "").replace("T", "T");
  }

  private toTrace(row: RowDataPacket): Trace {
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
      flagged_for_review: row.flagged_for_review === 1,
      superseded_by: row.superseded_by ?? null,
      caused_by: this.parseTags(row.caused_by),
    };
  }

  // ── Trace CRUD ──

  async insertTrace(trace: TraceInsert): Promise<{ id: string } | null> {
    const id = randomUUID();
    await this.pool.execute(
      `INSERT INTO traces (id, content, context, type, author, tags, confidence, caused_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, trace.content, trace.context ?? null, trace.type ?? "decision", trace.author, JSON.stringify(trace.tags), trace.confidence, JSON.stringify(trace.caused_by ?? [])]
    );
    return { id };
  }

  async getTraceFull(traceId: string, authorIds: string[], callerId?: string | null): Promise<Trace | null> {
    if (authorIds.length === 0) return null;
    const placeholders = authorIds.map(() => "?").join(",");
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT t.*, u.name AS author_name FROM traces t LEFT JOIN users u ON u.id = t.author WHERE t.id = ? AND t.author IN (${placeholders})`,
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

    if (update.content !== undefined) { sets.push("content = ?"); values.push(update.content); }
    if (update.context !== undefined) { sets.push("context = ?"); values.push(update.context); }
    if (update.status !== undefined) { sets.push("status = ?"); values.push(update.status); }
    if (update.superseded_by !== undefined) {
      sets.push("superseded_by = ?"); values.push(update.superseded_by ?? null);
      sets.push("status = 'superseded'");
    }
    if (update.tags !== undefined) { sets.push("tags = ?"); values.push(JSON.stringify(update.tags)); }
    if (update.confidence !== undefined) { sets.push("confidence = ?"); values.push(update.confidence); }

    if (sets.length === 0) return null;

    values.push(traceId, authorId);
    await this.pool.execute(
      `UPDATE traces SET ${sets.join(", ")} WHERE id = ? AND author = ?`,
      values as string[]
    );

    return this.getTraceFull(traceId, [authorId], authorId);
  }

  async filterTraces(params: FilterParams): Promise<Trace[]> {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    const selectValues: (string | number)[] = [];

    const { scope: scopeTags, filter: filterTags } = splitTags(params.tags ?? []);
    const limit = params.limit ?? 50;
    const queryText = params.query?.trim() || null;

    // FTS: MATCH() AGAINST() for keyword search
    let ftsRankExpr = "0 AS fts_rank";
    if (queryText) {
      ftsRankExpr = "MATCH(t.content, t.context) AGAINST(? IN NATURAL LANGUAGE MODE) AS fts_rank";
      selectValues.push(queryText);
      // Query only (no tags): use FULLTEXT as hard filter
      if (filterTags.length === 0) {
        conditions.push("MATCH(t.content, t.context) AGAINST(? IN NATURAL LANGUAGE MODE)");
        values.push(queryText);
      }
    }

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
        conditions.push("t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)");
        values.push(days);
      }
    }
    if (params.exclude_stale) {
      conditions.push("t.flagged_for_review = 0");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // MySQL params are positional: SELECT params first, then WHERE params, then LIMIT
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT t.*, u.name AS author_name, ${ftsRankExpr} FROM traces t LEFT JOIN users u ON u.id = t.author ${where} ORDER BY t.created_at DESC LIMIT ?`,
      [...selectValues, ...values, limit * 3]
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

      // MATCH relevance varies by doc length; normalize to 0-5 range
      const textScore = queryText ? Math.min(5, (row.fts_rank as number)) : 0;

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
    const ph = traceIds.map(() => "?").join(",");
    await this.pool.execute(
      `UPDATE traces SET access_count = access_count + 1, last_accessed_at = NOW(3) WHERE id IN (${ph})`,
      traceIds
    );
  }

  // ── Team access ──

  async getVisibleAuthorIds(userId: string): Promise<string[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT DISTINCT u2.id FROM users u1
       JOIN team_members tm1 ON tm1.user_id = u1.id
       JOIN team_members tm2 ON tm1.team_id = tm2.team_id
       JOIN users u2 ON tm2.user_id = u2.id
       WHERE u1.id = ?`,
      [userId]
    );
    const ids = rows.map(r => r.id as string);
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
    const ph = params.author_ids.map(() => "?").join(",");
    const [rows] = await this.pool.execute<RowDataPacket[]>(
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
          await this.pool.execute(
            `UPDATE traces SET decay_score = ?, flagged_for_review = 1 WHERE id = ?`,
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
    const ph = authorIds.map(() => "?").join(",");
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, author, content, tags FROM traces WHERE id = ? AND author IN (${ph})`,
      [traceId, ...authorIds]
    );
    if (rows.length === 0) return null;
    const tags = this.parseTags(rows[0].tags);
    if (tags.some(t => t.startsWith("private:")) && rows[0].author !== callerId) return null;
    return { id: rows[0].id, author: rows[0].author, content: rows[0].content };
  }

  async confirmStaleTrace(traceId: string, authorIds: string[]): Promise<boolean> {
    if (authorIds.length === 0) return false;
    const ph = authorIds.map(() => "?").join(",");
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE traces SET last_reviewed_at = NOW(3), decay_score = 1.0, flagged_for_review = 0
       WHERE id = ? AND author IN (${ph})`,
      [traceId, ...authorIds]
    );
    return result.affectedRows > 0;
  }

  async deprecateStaleTrace(traceId: string, authorIds: string[]): Promise<boolean> {
    if (authorIds.length === 0) return false;
    const ph = authorIds.map(() => "?").join(",");
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE traces SET status = 'deprecated', flagged_for_review = 0
       WHERE id = ? AND author IN (${ph})`,
      [traceId, ...authorIds]
    );
    return result.affectedRows > 0;
  }

  // ── Health ──

  async getKnowledgeHealth(tags: string[], authorIds: string[]): Promise<HealthData | null> {
    if (authorIds.length === 0) return null;
    const ph = authorIds.map(() => "?").join(",");
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM traces WHERE author IN (${ph})`,
      authorIds
    );

    const { scope: scopeTags } = splitTags(tags);
    const filtered = scopeTags.length > 0
      ? rows.filter(r => scopeTags.every(s => this.parseTags(r.tags).includes(s)))
      : rows;

    const now = Date.now();
    const active = filtered.filter(r => r.status === "active");
    const healthy = active.filter(r => !r.flagged_for_review);
    const stale = active.filter(r => r.flagged_for_review);

    const recent7d = active.filter(r => (now - new Date(r.created_at).getTime()) < 7 * 86400000);
    const recent30d = active.filter(r => (now - new Date(r.created_at).getTime()) < 30 * 86400000);

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

  private toUser(row: RowDataPacket, plaintextKey?: string): User {
    return {
      id: row.id,
      name: row.name,
      api_key: plaintextKey ?? `${row.api_key_prefix}${"*".repeat(16)}`,
      role: row.role,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  async listUsers(): Promise<User[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT * FROM users ORDER BY created_at DESC");
    return rows.map(r => this.toUser(r));
  }

  async getUserByApiKey(apiKey: string): Promise<User | null> {
    const hash = hashApiKey(apiKey);
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT * FROM users WHERE api_key_hash = ?", [hash]);
    return rows.length > 0 ? this.toUser(rows[0]) : null;
  }

  async insertUser(name: string, role: string): Promise<User> {
    const id = randomUUID();
    const apiKey = MariaDbAdapter.generateApiKey();
    const hash = hashApiKey(apiKey);
    const prefix = apiKey.slice(0, 7);
    await this.pool.execute(
      "INSERT INTO users (id, name, api_key_hash, api_key_prefix, role) VALUES (?, ?, ?, ?, ?)",
      [id, name, hash, prefix, role]
    );
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT * FROM users WHERE id = ?", [id]);
    return this.toUser(rows[0], apiKey);
  }

  async deleteUser(id: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>("DELETE FROM users WHERE id = ?", [id]);
    return result.affectedRows > 0;
  }

  async regenerateApiKey(id: string): Promise<User | null> {
    const apiKey = MariaDbAdapter.generateApiKey();
    const hash = hashApiKey(apiKey);
    const prefix = apiKey.slice(0, 7);
    const [result] = await this.pool.execute<ResultSetHeader>("UPDATE users SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?", [hash, prefix, id]);
    if (result.affectedRows === 0) return null;
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT * FROM users WHERE id = ?", [id]);
    return this.toUser(rows[0], apiKey);
  }

  async userCount(): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT COUNT(*) as cnt FROM users");
    return rows[0].cnt as number;
  }

  // ── Teams ──

  async listTeams(): Promise<Team[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT * FROM teams ORDER BY created_at DESC");
    return rows.map(r => ({ id: r.id, name: r.name, created_at: new Date(r.created_at).toISOString() }));
  }

  async insertTeam(name: string): Promise<Team> {
    const id = randomUUID();
    await this.pool.execute("INSERT INTO teams (id, name) VALUES (?, ?)", [id, name]);
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT * FROM teams WHERE id = ?", [id]);
    return { id: rows[0].id, name: rows[0].name, created_at: new Date(rows[0].created_at).toISOString() };
  }

  async deleteTeam(id: string): Promise<boolean> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("DELETE FROM team_members WHERE team_id = ?", [id]);
      const [result] = await conn.execute<ResultSetHeader>("DELETE FROM teams WHERE id = ?", [id]);
      await conn.commit();
      return result.affectedRows > 0;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async listTeamMembers(teamId: string): Promise<TeamMember[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT tm.id, tm.team_id, tm.user_id, tm.role, u.name as user_name
       FROM team_members tm LEFT JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = ?`, [teamId]
    );
    return rows.map(r => ({
      id: r.id, team_id: r.team_id, user_id: r.user_id,
      role: r.role, user_name: r.user_name ?? undefined,
    }));
  }

  async addTeamMember(teamId: string, userId: string, role: string = "member"): Promise<TeamMember> {
    const id = randomUUID();
    await this.pool.execute(
      "INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, ?)",
      [id, teamId, userId, role]
    );
    return { id, team_id: teamId, user_id: userId, role };
  }

  async removeTeamMember(teamId: string, userId: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "DELETE FROM team_members WHERE team_id = ? AND user_id = ?", [teamId, userId]
    );
    return result.affectedRows > 0;
  }
}
