/**
 * Trapic Core — DB-agnostic MCP tool engine
 *
 * This is the open-source core of Trapic. It provides:
 * - DbAdapter interface for any database
 * - All MCP tool logic (search, get, create, update, recall, decay, health)
 *
 * Auth is handled at the transport layer (HTTP/stdio), not here.
 * Tools receive a userId string — how you authenticate is up to you.
 */

export type {
  DbAdapter,
  Trace,
  TraceInsert,
  TraceUpdate,
  FilterParams,
  DecayResult,
  HealthData,
  ContextCandidate,
  User,
} from "./db-adapter.js";
