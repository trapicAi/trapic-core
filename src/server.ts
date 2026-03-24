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
const DB_PATH = process.env.TRAPIC_DB || "./data/trapic.db";
const DEFAULT_USER = process.env.TRAPIC_USER || "local-user";

// ── Database ─────────────────────────────────────────────────
import { mkdirSync } from "fs";
import { dirname } from "path";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db: DbAdapter = new SqliteDbAdapter(DB_PATH);
console.log(`[trapic] SQLite database: ${DB_PATH}`);

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
// Self-hosted: localhost-only by default, no token required.
// MCP clients always send a Bearer token — we just use DEFAULT_USER.
function resolveUser(authHeader: string | null): string {
  // Could extend: decode JWT, lookup user table, etc.
  return DEFAULT_USER;
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
    res.end(JSON.stringify({ status: "ok", server: "trapic-mcp", mode: "sqlite" }));
    return;
  }

  // MCP endpoint
  if (url.pathname === "/mcp") {
    // Only POST
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    // Resolve user (localhost-only, no auth needed)
    const userId = resolveUser(req.headers.authorization || null);

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
warnIfNoopHooks();

httpServer.listen(PORT, HOST, () => {
  console.log(`[trapic] MCP server running at http://${HOST}:${PORT}/mcp`);
  console.log(`[trapic] Health check: http://${HOST}:${PORT}/health`);
  if (HOST === "127.0.0.1") {
    console.log(`[trapic] Listening on localhost only. Set TRAPIC_HOST=0.0.0.0 to expose.`);
  }
});
