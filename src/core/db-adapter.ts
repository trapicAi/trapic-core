/**
 * Database Adapter Interface
 *
 * Abstracts all database operations so the core MCP tools work with
 * any database (Postgres, SQLite, MySQL, etc).
 *
 * The SQLite adapter (sqlite-db.ts) provides the reference implementation.
 * Implement this interface to use your own database.
 */

// ── Types ────────────────────────────────────────────────────

export interface Trace {
  id: string;
  content: string;
  context: string | null;
  status: string;
  type: string;
  tags: string[];           // includes project:*, branch:*, topic:*, type tags — all in one
  confidence: string;
  author: string;
  author_name?: string;
  created_at: string;
  updated_at: string;
  flagged_for_review?: boolean;
  superseded_by?: string | null;
  caused_by?: string[];
}

export interface TraceInsert {
  content: string;
  context?: string | null;
  type?: string;            // "decision" | "fact" | "convention" | "state" | "preference"
  author: string;
  tags: string[];           // includes project:*, branch:* alongside topic tags
  confidence: string;
  caused_by?: string[];     // IDs of traces that caused/led to this one
}

export interface TraceUpdate {
  content?: string;
  context?: string;
  status?: string;
  superseded_by?: string;
  tags?: string[];
  confidence?: string;
}

export interface FilterParams {
  tags?: string[];           // project:*, branch:* → AND logic; others → OR logic
  status?: string;
  author_ids: string[];
  query?: string | null;
  time_days?: number | null;
  types?: string[];
  limit?: number;
  caller_id?: string | null;
  exclude_stale?: boolean;
}

export interface DecayResult {
  id: string;
  content: string;
  type: string;
  tags: string[];
  confidence: string;
  age_days: number;
  decay_score: number;
  half_life_days: number;
  last_reviewed_at: string | null;
}

export interface HealthData {
  total_traces: number;
  active_traces: number;
  stale_traces: number;
  health_pct: number;
  by_type: Record<string, number>;
  by_confidence: Record<string, number>;
  recent_7d: number;
  recent_30d: number;
}

export interface ContextCandidate {
  id: string;
  summary: string;
  trace_count: number;
}

export interface User {
  id: string;
  name: string;
  api_key: string;
  role: string;        // "admin" | "user"
  created_at: string;
}

export interface Team {
  id: string;
  name: string;
  created_at: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: string;
  user_name?: string;
}

// ── Adapter Interface ────────────────────────────────────────

export interface DbAdapter {
  // ── Lifecycle ──
  /** Graceful shutdown — close connections/pools */
  close?(): Promise<void>;

  // ── Trace CRUD ──
  /** Insert a new trace. Returns { id: string } */
  insertTrace(trace: TraceInsert): Promise<{ id: string } | null>;

  /** Get a single trace by ID with author visibility check */
  getTraceFull(traceId: string, authorIds: string[], callerId?: string | null): Promise<Trace | null>;

  /** Update trace fields. Returns updated trace or null if not found/not authorized */
  updateTrace(traceId: string, authorId: string, update: TraceUpdate): Promise<Trace | null>;

  /** Filter traces with combined tag/keyword OR logic and scoring */
  filterTraces(params: FilterParams): Promise<Trace[]>;

  /** Increment access count for traces (fire-and-forget OK) */
  incrementAccessCount(traceIds: string[]): Promise<void>;

  // ── Team access ──
  /** Get all visible author IDs (self + team members) */
  getVisibleAuthorIds(userId: string): Promise<string[]>;

  // ── Decay ──
  /** Calculate decay scores, return stale traces */
  calculateDecayScores(params: {
    author_ids: string[];
    flag_threshold: number;
    dry_run: boolean;
    scope?: string[];
    caller_id?: string | null;
  }): Promise<DecayResult[]>;

  /** Get trace for stale review (minimal fields) */
  getTraceForReview(traceId: string, authorIds: string[], callerId?: string | null): Promise<{ id: string; author: string; content: string } | null>;

  /** Confirm stale trace (reset decay) */
  confirmStaleTrace(traceId: string, authorIds: string[]): Promise<boolean>;

  /** Deprecate stale trace */
  deprecateStaleTrace(traceId: string, authorIds: string[]): Promise<boolean>;

  // ── Health ──
  /** Get knowledge health statistics. tags can include project:* for filtering. */
  getKnowledgeHealth(tags: string[], authorIds: string[]): Promise<HealthData | null>;

  // ── Context (optional, for recall) ──
  /** Find candidate context clusters */
  findCandidateContexts?(tags: string[], authorIds: string[]): Promise<ContextCandidate[]>;

  // ── Users ──
  /** List all users */
  listUsers(): Promise<User[]>;
  /** Look up a user by API key (for auth) */
  getUserByApiKey(apiKey: string): Promise<User | null>;
  /** Create a new user with auto-generated id and api_key */
  insertUser(name: string, role: string): Promise<User>;
  /** Delete a user by id */
  deleteUser(id: string): Promise<boolean>;
  /** Regenerate api_key for a user */
  regenerateApiKey(id: string): Promise<User | null>;
  /** Count total users */
  userCount(): Promise<number>;

  // ── Teams ──
  /** List all teams */
  listTeams(): Promise<Team[]>;
  /** Create a new team */
  insertTeam(name: string): Promise<Team>;
  /** Delete a team and its memberships */
  deleteTeam(id: string): Promise<boolean>;
  /** List members of a team (with user names) */
  listTeamMembers(teamId: string): Promise<TeamMember[]>;
  /** Add a user to a team */
  addTeamMember(teamId: string, userId: string, role?: string): Promise<TeamMember>;
  /** Remove a user from a team */
  removeTeamMember(teamId: string, userId: string): Promise<boolean>;
}
