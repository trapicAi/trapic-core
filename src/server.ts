/**
 * Standalone HTTP server for Trapic MCP
 *
 * Open-source standalone server. SQLite or MariaDB storage.
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
import { adminHtml } from "./admin-ui.js";
import { createServer as createHttpServer, IncomingMessage } from "http";

// ── Config ───────────────────────────────────────────────────
const PORT = parseInt(process.env.TRAPIC_PORT || "3000", 10);
const HOST = process.env.TRAPIC_HOST || "127.0.0.1";
const DB_ADAPTER = process.env.TRAPIC_DB_ADAPTER || "sqlite"; // "sqlite" | "mariadb"
const DB_PATH = process.env.TRAPIC_DB || "./data/trapic.db";
const DEFAULT_USER = process.env.TRAPIC_USER || "local-user";
const ADMIN_PASSWORD = process.env.TRAPIC_ADMIN_PASSWORD || "";

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

// ── Helpers ──────────────────────────────────────────────────

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function readBody(req: IncomingMessage, maxSize: number = 1024 * 1024): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += (chunk as Buffer).length;
    if (totalSize > maxSize) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// ── Auth ─────────────────────────────────────────────────────

type AuthResult = {
  ok: true;
  userId: string;
} | {
  ok: false;
  status: number;
  error: string;
};

async function authenticate(authHeader: string | null): Promise<AuthResult> {
  const userCount = await db.userCount();

  // Open mode: no users in DB and no admin password → anyone can access
  if (userCount === 0 && !ADMIN_PASSWORD) {
    return { ok: true, userId: DEFAULT_USER };
  }

  const token = extractBearer(authHeader);

  if (!token) {
    return { ok: false, status: 401, error: "Missing Authorization header. Use: Bearer <api-key>" };
  }

  // Look up token in users table
  if (userCount > 0) {
    const user = await db.getUserByApiKey(token);
    if (user) {
      return { ok: true, userId: user.name };
    }
  }

  return { ok: false, status: 403, error: "Invalid API key" };
}

// ── Admin Auth ───────────────────────────────────────────────

function authenticateAdmin(authHeader: string | null): boolean {
  if (!ADMIN_PASSWORD) return false;
  const token = extractBearer(authHeader);
  if (!token) return false;
  return constantTimeEqual(token, ADMIN_PASSWORD);
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

  const json = (status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  // Health check
  if (url.pathname === "/health") {
    json(200, { status: "ok", server: "trapic-mcp", mode: DB_ADAPTER });
    return;
  }

  // ── Admin UI ──────────────────────────────────────────────
  if (url.pathname === "/admin" && req.method === "GET") {
    if (!ADMIN_PASSWORD) {
      json(403, { error: "Admin UI disabled. Set TRAPIC_ADMIN_PASSWORD to enable." });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(adminHtml());
    return;
  }

  // ── Admin API ─────────────────────────────────────────────
  if (url.pathname.startsWith("/admin/api/")) {
    if (!ADMIN_PASSWORD) {
      json(403, { error: "Admin API disabled. Set TRAPIC_ADMIN_PASSWORD to enable." });
      return;
    }
    if (!authenticateAdmin(req.headers.authorization || null)) {
      json(401, { error: "Invalid admin password" });
      return;
    }

    // GET /admin/api/users
    if (url.pathname === "/admin/api/users" && req.method === "GET") {
      const users = await db.listUsers();
      json(200, { users });
      return;
    }

    // POST /admin/api/users
    if (url.pathname === "/admin/api/users" && req.method === "POST") {
      const body = await readBody(req);
      if (!body) { json(413, { error: "Payload too large" }); return; }
      let parsed: { name?: string; role?: string };
      try { parsed = JSON.parse(body.toString()); } catch { json(400, { error: "Invalid JSON" }); return; }
      const name = parsed.name?.trim();
      const role = parsed.role === "admin" ? "admin" : "user";
      if (!name) { json(400, { error: "name is required" }); return; }
      const user = await db.insertUser(name, role);
      json(201, { user });
      return;
    }

    // DELETE /admin/api/users/:id
    const deleteMatch = url.pathname.match(/^\/admin\/api\/users\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      const ok = await db.deleteUser(deleteMatch[1]);
      if (!ok) { json(404, { error: "User not found" }); return; }
      json(200, { ok: true });
      return;
    }

    // POST /admin/api/users/:id/regenerate
    const regenMatch = url.pathname.match(/^\/admin\/api\/users\/([^/]+)\/regenerate$/);
    if (regenMatch && req.method === "POST") {
      const user = await db.regenerateApiKey(regenMatch[1]);
      if (!user) { json(404, { error: "User not found" }); return; }
      json(200, { user });
      return;
    }

    // ── Team API ──

    // GET /admin/api/teams
    if (url.pathname === "/admin/api/teams" && req.method === "GET") {
      const teams = await db.listTeams();
      json(200, { teams });
      return;
    }

    // POST /admin/api/teams
    if (url.pathname === "/admin/api/teams" && req.method === "POST") {
      const body = await readBody(req);
      if (!body) { json(413, { error: "Payload too large" }); return; }
      let parsed: { name?: string };
      try { parsed = JSON.parse(body.toString()); } catch { json(400, { error: "Invalid JSON" }); return; }
      const name = parsed.name?.trim();
      if (!name) { json(400, { error: "name is required" }); return; }
      const team = await db.insertTeam(name);
      json(201, { team });
      return;
    }

    // DELETE /admin/api/teams/:id
    const deleteTeamMatch = url.pathname.match(/^\/admin\/api\/teams\/([^/]+)$/);
    if (deleteTeamMatch && req.method === "DELETE") {
      const ok = await db.deleteTeam(deleteTeamMatch[1]);
      if (!ok) { json(404, { error: "Team not found" }); return; }
      json(200, { ok: true });
      return;
    }

    // GET /admin/api/teams/:id/members
    const listMembersMatch = url.pathname.match(/^\/admin\/api\/teams\/([^/]+)\/members$/);
    if (listMembersMatch && req.method === "GET") {
      const members = await db.listTeamMembers(listMembersMatch[1]);
      json(200, { members });
      return;
    }

    // POST /admin/api/teams/:id/members
    const addMemberMatch = url.pathname.match(/^\/admin\/api\/teams\/([^/]+)\/members$/);
    if (addMemberMatch && req.method === "POST") {
      const body = await readBody(req);
      if (!body) { json(413, { error: "Payload too large" }); return; }
      let parsed: { user_id?: string; role?: string };
      try { parsed = JSON.parse(body.toString()); } catch { json(400, { error: "Invalid JSON" }); return; }
      if (!parsed.user_id) { json(400, { error: "user_id is required" }); return; }
      const member = await db.addTeamMember(addMemberMatch[1], parsed.user_id, parsed.role || "member");
      json(201, { member });
      return;
    }

    // DELETE /admin/api/teams/:teamId/members/:userId
    const removeMemberMatch = url.pathname.match(/^\/admin\/api\/teams\/([^/]+)\/members\/([^/]+)$/);
    if (removeMemberMatch && req.method === "DELETE") {
      const ok = await db.removeTeamMember(removeMemberMatch[1], removeMemberMatch[2]);
      if (!ok) { json(404, { error: "Member not found" }); return; }
      json(200, { ok: true });
      return;
    }

    json(404, { error: "Not found" });
    return;
  }

  // ── MCP endpoint ──────────────────────────────────────────
  if (url.pathname === "/mcp") {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    const auth = await authenticate(req.headers.authorization || null);
    if (!auth.ok) {
      json(auth.status, { error: auth.error });
      return;
    }
    const userId = auth.userId;

    const body = await readBody(req);
    if (!body) {
      json(413, { error: "Payload too large" });
      return;
    }

    const server = createMcpServer(userId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);

    const webRequest = new Request(url.toString(), {
      method: "POST",
      headers: Object.fromEntries(
        Object.entries(req.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v as string])
      ),
      body: new Uint8Array(body),
    });

    const response = await transport.handleRequest(webRequest);

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const respBody = await response.text();
    res.end(respBody);
    return;
  }

  // 404
  json(404, { error: "Not found" });
});

// ── Start ────────────────────────────────────────────────────
async function main() {
  db = await initDb();
  warnIfNoopHooks();

  httpServer.listen(PORT, HOST, () => {
    console.log(`[trapic] MCP server running at http://${HOST}:${PORT}/mcp`);
    console.log(`[trapic] Health check: http://${HOST}:${PORT}/health`);
    if (ADMIN_PASSWORD) {
      console.log(`[trapic] Admin UI: http://${HOST}:${PORT}/admin`);
    }
    const userCountPromise = db.userCount().then(count => {
      if (count > 0) {
        console.log(`[trapic] Auth: API key required (${count} user(s) in database)`);
      } else if (ADMIN_PASSWORD) {
        console.log(`[trapic] Auth: open (no users yet — create users at /admin)`);
      } else {
        console.log(`[trapic] Auth: open (set TRAPIC_ADMIN_PASSWORD to enable user management)`);
      }
    });
    userCountPromise.catch(() => {});
    if (HOST === "127.0.0.1") {
      console.log(`[trapic] Listening on localhost only. Set TRAPIC_HOST=0.0.0.0 to expose.`);
    }
  });
}

main().catch((err) => {
  console.error("[trapic] Failed to start:", err);
  process.exit(1);
});
