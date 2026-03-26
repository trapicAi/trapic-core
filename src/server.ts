/**
 * Standalone HTTP server for Trapic MCP (Node.js + SQLite)
 *
 * Open-source standalone server. SQLite storage, zero vendor dependencies.
 * Uses SQLite for storage. Localhost-only by default (no auth needed).
 *
 * Usage:
 *   npx tsx src/server.ts
 *
 * Docker:
 *   docker compose up
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SqliteDbAdapter } from "./core/adapters/sqlite-db.js";
import { MariaDbAdapter } from "./core/adapters/mariadb-db.js";
import { DbAdapter } from "./core/db-adapter.js";
import { warnIfNoopHooks } from "./core/hooks.js";
import { registerCreate } from "./tools/create.js";
import { registerSearch } from "./tools/search.js";
import { registerGet } from "./tools/get.js";
import { registerUpdate } from "./tools/update.js";
import { registerRecall } from "./tools/recall.js";
import { registerHealth } from "./tools/health.js";
import { registerDecay } from "./tools/decay.js";
import { registerImportGit } from "./tools/import-git.js";
import { createServer as createHttpServer } from "http";

// ── Config ───────────────────────────────────────────────────
const PORT = parseInt(process.env.TRAPIC_PORT || "3000", 10);
const HOST = process.env.TRAPIC_HOST || "127.0.0.1";
const DB_ADAPTER = process.env.TRAPIC_DB_ADAPTER || "sqlite"; // "sqlite" | "mariadb"
const DB_PATH = process.env.TRAPIC_DB || "./data/trapic.db";
const DEFAULT_USER = process.env.TRAPIC_USER || "local-user";
const API_KEYS = (process.env.TRAPIC_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);

// MariaDB config (used when TRAPIC_DB_ADAPTER=mariadb)
const MARIADB_HOST = process.env.TRAPIC_MARIADB_HOST || "localhost";
const MARIADB_PORT = parseInt(process.env.TRAPIC_MARIADB_PORT || "3306", 10);
const MARIADB_USER = process.env.TRAPIC_MARIADB_USER || "trapic";
const MARIADB_PASSWORD = process.env.TRAPIC_MARIADB_PASSWORD || "";
const MARIADB_DATABASE = process.env.TRAPIC_MARIADB_DATABASE || "trapic";

// ── Database ─────────────────────────────────────────────────
import { mkdirSync } from "fs";
import { dirname } from "path";

let db: DbAdapter;

async function initDb(): Promise<DbAdapter> {
  if (DB_ADAPTER === "mariadb") {
    const adapter = await MariaDbAdapter.create({
      host: MARIADB_HOST,
      port: MARIADB_PORT,
      user: MARIADB_USER,
      password: MARIADB_PASSWORD,
      database: MARIADB_DATABASE,
    });
    console.log(`[trapic] MariaDB: ${MARIADB_USER}@${MARIADB_HOST}:${MARIADB_PORT}/${MARIADB_DATABASE}`);
    return adapter;
  }

  mkdirSync(dirname(DB_PATH), { recursive: true });
  console.log(`[trapic] SQLite database: ${DB_PATH}`);
  return new SqliteDbAdapter(DB_PATH);
}

// ── MCP Server factory ───────────────────────────────────────
function createMcpServer(userId: string): McpServer {
  const server = new McpServer({
    name: "trapic-mcp",
    version: "1.0.0",
  });

  registerCreate(server, userId, db);
  registerSearch(server, userId, db);
  registerGet(server, userId, db);
  registerUpdate(server, userId, db);
  registerRecall(server, userId, db);
  registerHealth(server, userId, db);
  registerDecay(server, userId, db);
  registerImportGit(server, userId, db);

  return server;
}

// ── Auth ─────────────────────────────────────────────────────
// When TRAPIC_API_KEYS is set, Bearer token is required.
// When unset, localhost-only mode — no auth needed.

type AuthResult = {
  ok: true;
  userId: string;
} | {
  ok: false;
  status: number;
  error: string;
};

function authenticate(authHeader: string | null): AuthResult {
  // No API keys configured → open mode (localhost use)
  if (API_KEYS.length === 0) {
    return { ok: true, userId: DEFAULT_USER };
  }

  if (!authHeader) {
    return { ok: false, status: 401, error: "Missing Authorization header. Use: Bearer <api-key>" };
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, status: 401, error: "Invalid Authorization format. Use: Bearer <api-key>" };
  }

  const token = match[1];

  // Constant-time comparison to prevent timing attacks
  const valid = API_KEYS.some(key => {
    if (key.length !== token.length) return false;
    let result = 0;
    for (let i = 0; i < key.length; i++) {
      result |= key.charCodeAt(i) ^ token.charCodeAt(i);
    }
    return result === 0;
  });

  if (!valid) {
    return { ok: false, status: 403, error: "Invalid API key" };
  }

  return { ok: true, userId: DEFAULT_USER };
}

// ── HTTP Server ──────────────────────────────────────────────
const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "trapic-mcp", mode: DB_ADAPTER }));
    return;
  }

  // MCP endpoint
  if (url.pathname === "/mcp") {
    // Only POST
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    // Authenticate
    const auth = authenticate(req.headers.authorization || null);
    if (!auth.ok) {
      res.writeHead(auth.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: auth.error }));
      return;
    }
    const userId = auth.userId;

    // Read body (1MB limit)
    const MAX_BODY = 1024 * 1024;
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += (chunk as Buffer).length;
      if (totalSize > MAX_BODY) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    // Create MCP server + transport for this request
    const server = createMcpServer(userId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);

    // Convert Node.js IncomingMessage to Web Request
    const webRequest = new Request(url.toString(), {
      method: "POST",
      headers: Object.fromEntries(
        Object.entries(req.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v as string])
      ),
      body,
    });

    const response = await transport.handleRequest(webRequest);

    // Write Web Response back to Node.js
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const respBody = await response.text();
    res.end(respBody);
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ── Start ────────────────────────────────────────────────────
async function main() {
  db = await initDb();
  warnIfNoopHooks();

  httpServer.listen(PORT, HOST, () => {
    console.log(`[trapic] MCP server running at http://${HOST}:${PORT}/mcp`);
    console.log(`[trapic] Health check: http://${HOST}:${PORT}/health`);
    if (API_KEYS.length > 0) {
      console.log(`[trapic] Auth: Bearer token required (${API_KEYS.length} API key(s) configured)`);
    } else {
      console.log(`[trapic] Auth: open (no TRAPIC_API_KEYS set)`);
    }
    if (HOST === "127.0.0.1") {
      console.log(`[trapic] Listening on localhost only. Set TRAPIC_HOST=0.0.0.0 to expose.`);
    }
  });
}

main().catch((err) => {
  console.error("[trapic] Failed to start:", err);
  process.exit(1);
});
