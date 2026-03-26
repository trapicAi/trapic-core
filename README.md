# Trapic Core — Self-Hosted AI Knowledge Memory Engine

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE) [![MCP](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io)

> **Long-term memory for AI coding assistants. Self-hosted, SQLite or MariaDB, zero vendor dependencies.**

Trapic Core is a standalone [MCP](https://modelcontextprotocol.io) server that gives your AI assistant persistent memory across sessions. Decisions, conventions, and discoveries are captured, searched, and recalled — automatically.

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/nickjazz/trapic-core.git
cd trapic-core
docker compose up
```

Server runs at `http://localhost:3000/mcp`.

### Node.js

```bash
git clone https://github.com/nickjazz/trapic-core.git
cd trapic-core
npm install
npm run build
npm start
```

## MCP Server

Trapic Core is a fully compliant [Model Context Protocol](https://modelcontextprotocol.io) server. It uses **Streamable HTTP** transport via `@modelcontextprotocol/sdk`, exposing a single endpoint at `/mcp`.

### Protocol Details

| Property | Value |
|----------|-------|
| **Server name** | `trapic-mcp` |
| **Transport** | Streamable HTTP (`POST /mcp`) |
| **SDK** | `@modelcontextprotocol/sdk` |
| **Auth** | Bearer token (optional — enabled via `TRAPIC_API_KEYS`) |
| **Health check** | `GET /health` |

### Connecting MCP Clients

**Claude Code / Cursor / Windsurf** — add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "trapic": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trapic": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### MCP Tools

Trapic Core registers 9 MCP tools:

#### `trapic-create`

Create a new knowledge trace (decision, convention, fact, state, preference).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | The knowledge content (max 5000 chars) |
| `context` | string | No | Additional context or reasoning |
| `tags` | string[] | No | Tags for categorization (e.g. `project:my-app`, `topic:auth`) |
| `confidence` | `high` \| `medium` \| `low` | No | Confidence level (default: `medium`) |

#### `trapic-search`

Search traces by keywords, tags, type, and time range. Tags with `project:` / `branch:` prefix use AND logic; others use OR logic.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Keyword search (max 500 chars) |
| `tags` | string[] | No | Filter tags |
| `status` | `active` \| `superseded` \| `deprecated` | No | Status filter (default: `active`) |
| `types` | string[] | No | Filter by trace type |
| `time_days` | number | No | Only return traces from the last N days |
| `limit` | number | No | Max results (default: 10, max: 50) |

#### `trapic-recall`

Session briefing — load project foundations, team updates, recent activity, and open plans. Call at the start of each session for automatic context loading.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context` | string | Yes | What you're working on |
| `project` | string | No | Project name to scope recall |
| `tags` | string[] | No | Additional filter tags |
| `max_contexts` | number | No | Max context clusters (default: 5, max: 10) |

#### `trapic-update`

Update an existing trace — change content, status, tags, or mark as superseded.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `trace_id` | UUID | Yes | The trace ID to update |
| `content` | string | No | New content |
| `context` | string | No | New context |
| `status` | `active` \| `superseded` \| `deprecated` | No | New status |
| `superseded_by` | UUID | No | ID of the trace that supersedes this one |
| `tags` | string[] | No | New tags |
| `confidence` | `high` \| `medium` \| `low` | No | New confidence level |

#### `trapic-get`

Get the full content of a single trace by ID. Use after `trapic-search` to read complete details.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `trace_id` | UUID | Yes | The trace ID |

#### `trapic-health`

Knowledge health report — project health score, type distribution, stale/healthy ratio, and activity trends.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | No | Project name to scope |
| `tags` | string[] | No | Additional filter tags |

#### `trapic-decay`

Scan for stale/decaying knowledge. Traces decay based on type-specific half-lives (state: 30d, decision: 90d, convention: 180d, preference: 180d, fact: 365d).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | No | Project name to scope |
| `tags` | string[] | No | Additional filter tags |
| `threshold` | number | No | Decay score threshold (default: 0.3) |
| `dry_run` | boolean | No | Preview only, don't flag traces (default: `true`) |

#### `trapic-review-stale`

Review a stale trace: confirm it's still valid (resets decay) or deprecate it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `trace_id` | UUID | Yes | The stale trace ID |
| `action` | `confirm` \| `deprecate` | Yes | Confirm (reset decay) or deprecate |
| `reason` | string | No | Reason for the action |

#### `trapic-import-git`

Import knowledge from git commit history. Analyzes commits and creates traces to bootstrap a project's knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string (URL) | Yes | Git repository URL (HTTP/HTTPS) |
| `project` | string | Yes | Project name |
| `branch` | string | No | Branch to import (default: `main`) |
| `max_commits` | number | No | Max commits to analyze (default: 100, max: 500) |
| `since` | string | No | Only import commits after this date (YYYY-MM-DD) |
| `dry_run` | boolean | No | Preview only (default: `true`) |

## How It Works

```
AI writes code → captures knowledge → stored as structured traces
AI starts session → recalls project context → instant briefing
AI searches → tag + keyword query → precise results, no embeddings
```

Each knowledge trace has:

```
type:       decision | convention | fact | state | preference
content:    "Chose CSS custom properties over Tailwind theme config"
context:    "Tailwind doesn't support runtime theme switching"
tags:       [topic:theming, topic:css, project:my-app]
confidence: high | medium | low
```

Search uses **structured tags + full-text search** — no vector database, no embeddings, no API costs.

## Architecture

```
┌─────────────┐     MCP/HTTP      ┌──────────────┐     SQLite      ┌──────────┐
│  AI Client  │ ◄───────────────► │ Trapic Core  │ ◄─────────────► │ trapic.db│
│ Claude Code │     localhost      │  MCP Server  │   or MariaDB   └──────────┘
│ Cursor, etc │                   └──────────────┘
└─────────────┘
```

- **Transport**: HTTP with MCP protocol (Streamable HTTP)
- **Storage**: SQLite (default) or MariaDB — switchable via env var
- **Auth**: Bearer token (optional) — open by default, enable with `TRAPIC_API_KEYS`
- **Deployment**: Docker, Kubernetes, or bare Node.js

## Database Adapters

Trapic Core supports two database backends, switchable via the `TRAPIC_DB_ADAPTER` environment variable.

### SQLite (default)

Zero-config, file-based storage. Best for single-instance deployments.

```bash
# Default — no extra config needed
docker compose up
```

### MariaDB

Production-ready with connection pooling. Supports horizontal scaling (multiple replicas).

```bash
# Docker Compose with MariaDB
docker compose -f docker-compose.mariadb.yml up
```

MariaDB environment variables:

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `TRAPIC_DB_ADAPTER` | `sqlite` | Set to `mariadb` to use MariaDB |
| `TRAPIC_MARIADB_HOST` | `localhost` | MariaDB host |
| `TRAPIC_MARIADB_PORT` | `3306` | MariaDB port |
| `TRAPIC_MARIADB_USER` | `trapic` | MariaDB user |
| `TRAPIC_MARIADB_PASSWORD` | — | MariaDB password |
| `TRAPIC_MARIADB_DATABASE` | `trapic` | MariaDB database name |

## Kubernetes Deployment

K8s manifests are provided in the `k8s/` directory.

### SQLite mode (single replica)

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

> **Note**: SQLite mode uses `replicas: 1` with `Recreate` strategy to avoid concurrent writes to the same database file.

### MariaDB mode (scalable)

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/mariadb.yaml
kubectl apply -f k8s/deployment-mariadb.yaml
kubectl apply -f k8s/service.yaml
```

MariaDB mode supports multiple replicas (`replicas: 2` by default). Remember to update the `image` field in the deployment manifests to your container registry (e.g. `ghcr.io/nickjazz/trapic-core:latest`).

## Authentication

By default, Trapic Core runs in **open mode** — no authentication required. This is suitable for localhost-only deployments.

To enable authentication, set the `TRAPIC_API_KEYS` environment variable with one or more comma-separated API keys:

```bash
# Single key
export TRAPIC_API_KEYS="sk-my-secret-key-123"

# Multiple keys (e.g. one per team member or client)
export TRAPIC_API_KEYS="sk-alice-key,sk-bob-key,sk-ci-key"
```

When API keys are configured, all requests to `/mcp` must include a `Bearer` token:

```
Authorization: Bearer sk-my-secret-key-123
```

The `/health` endpoint remains unauthenticated for load balancer health checks.

### MCP Client Configuration with Auth

**Claude Code / Cursor / Windsurf** — add `headers` to `.mcp.json`:

```json
{
  "mcpServers": {
    "trapic": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer sk-my-secret-key-123"
      }
    }
  }
}
```

### Auth Behavior

| `TRAPIC_API_KEYS` | Behavior |
|---|---|
| Not set (default) | Open mode — all requests accepted |
| Set | Bearer token required — returns `401` if missing, `403` if invalid |

Token validation uses constant-time comparison to prevent timing attacks.

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `TRAPIC_PORT` | `3000` | Server port |
| `TRAPIC_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose) |
| `TRAPIC_DB` | `./data/trapic.db` | SQLite database path |
| `TRAPIC_USER` | `local-user` | Default user ID |
| `TRAPIC_DB_ADAPTER` | `sqlite` | Database backend: `sqlite` or `mariadb` |
| `TRAPIC_API_KEYS` | — | Comma-separated API keys for Bearer auth |

## Cloud Version

Don't want to self-host? [trapic.ai](https://trapic.ai) offers a hosted version with team collaboration and managed infrastructure.

Use the [Trapic Plugin](https://github.com/nickjazz/trapic-plugin) for one-click setup with the cloud version.

## License

MIT
