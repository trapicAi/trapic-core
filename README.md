# Trapic Core

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE) [![MCP](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io)

> Self-hosted long-term memory for AI coding assistants.

Your AI forgets everything between sessions. Trapic Core is an [MCP](https://modelcontextprotocol.io) server that fixes that — decisions, conventions, and discoveries are captured as structured traces, searched by tags and keywords, and recalled automatically at session start.

No vector database. No embeddings. No API costs.

## Quick Start

```bash
git clone https://github.com/nickjazz/trapic-core.git
cd trapic-core
docker compose up
```

Server runs at `http://localhost:3000/mcp`. Connect your AI tool:

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

Save as `.mcp.json` in your project root (Claude Code, Cursor, Windsurf) or add to `claude_desktop_config.json` (Claude Desktop).

## How It Works

```
AI writes code  →  captures knowledge  →  stored as structured traces
AI starts session  →  recalls project context  →  instant briefing
AI searches  →  tag + keyword query  →  precise results
```

Each knowledge trace:

```
type:        decision | convention | fact | state | preference
content:     "Chose CSS custom properties over Tailwind theme config"
context:     "Tailwind doesn't support runtime theme switching"
tags:        [topic:theming, topic:css, project:my-app, branch:main]
confidence:  high | medium | low
```

Tags with `project:` / `branch:` use AND logic (must all match). `topic:` tags use OR logic (any match counts). Combined with full-text search and recency scoring.

## MCP Tools

| Tool | Description |
|------|-------------|
| `trapic-create` | Create a knowledge trace |
| `trapic-search` | Search by tags, keywords, type, time range |
| `trapic-recall` | Session briefing — load project context on startup |
| `trapic-update` | Update content, status, tags, or supersede a trace |
| `trapic-get` | Get full trace by ID |
| `trapic-health` | Health report — type distribution, stale ratio, trends |
| `trapic-decay` | Scan for stale knowledge (type-specific half-lives) |
| `trapic-review-stale` | Confirm or deprecate a stale trace |
| `trapic-import-git` | Bootstrap knowledge from git commit history |

<details>
<summary>Full parameter reference</summary>

### trapic-create

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | The knowledge content (max 5000 chars) |
| `context` | string | No | Why — the causal explanation |
| `tags` | string[] | No | Type + topic + project/branch tags |
| `confidence` | `high` \| `medium` \| `low` | No | Default: `medium` |

### trapic-search

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Keyword search (max 500 chars) |
| `tags` | string[] | No | Filter tags (project/branch = AND, topic = OR) |
| `status` | `active` \| `superseded` \| `deprecated` | No | Default: `active` |
| `types` | string[] | No | Filter by trace type |
| `time_days` | number | No | Only last N days |
| `limit` | number | No | Max results (default: 10, max: 50) |

### trapic-recall

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context` | string | Yes | What you're working on |
| `project` | string | No | Project name to scope |
| `tags` | string[] | No | Additional filter tags |
| `max_contexts` | number | No | Max context clusters (default: 5, max: 10) |

### trapic-update

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `trace_id` | UUID | Yes | Trace to update |
| `content` | string | No | New content |
| `context` | string | No | New context |
| `status` | `active` \| `superseded` \| `deprecated` | No | New status |
| `superseded_by` | UUID | No | ID of replacing trace |
| `tags` | string[] | No | New tags |
| `confidence` | `high` \| `medium` \| `low` | No | New confidence |

### trapic-get

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `trace_id` | UUID | Yes | Trace ID |

### trapic-health

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | No | Project name to scope |
| `tags` | string[] | No | Additional filter tags |

### trapic-decay

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | No | Project name to scope |
| `tags` | string[] | No | Additional filter tags |
| `threshold` | number | No | Decay score threshold (default: 0.3) |
| `dry_run` | boolean | No | Preview only (default: `true`) |

### trapic-review-stale

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `trace_id` | UUID | Yes | Stale trace ID |
| `action` | `confirm` \| `deprecate` | Yes | Confirm (reset decay) or deprecate |
| `reason` | string | No | Reason for the action |

### trapic-import-git

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Git repository URL (HTTPS) |
| `project` | string | Yes | Project name |
| `branch` | string | No | Branch (default: `main`) |
| `max_commits` | number | No | Max commits (default: 100, max: 500) |
| `since` | string | No | After this date (YYYY-MM-DD) |
| `dry_run` | boolean | No | Preview only (default: `true`) |

</details>

## Database

Three backends, switchable via `TRAPIC_DB_ADAPTER`:

| Backend | Best for | Scaling | Full-text search |
|---------|----------|---------|-----------------|
| **SQLite** (default) | Local dev, single user | Single instance | FTS5 |
| **PostgreSQL** | Production, teams | Horizontal (multiple replicas) | tsvector + GIN |
| **MariaDB** | Production, teams | Horizontal (multiple replicas) | FULLTEXT index |

### SQLite

Zero config. Data in `./data/trapic.db`.

```bash
docker compose up
```

### PostgreSQL

```bash
cp .env.example .env  # set PG_PASSWORD
docker compose -f docker-compose.postgres.yml up
```

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `TRAPIC_PG_HOST` | `localhost` | Host |
| `TRAPIC_PG_PORT` | `5432` | Port |
| `TRAPIC_PG_USER` | `trapic` | User |
| `TRAPIC_PG_PASSWORD` | — | Password |
| `TRAPIC_PG_DATABASE` | `trapic` | Database |

### MariaDB

```bash
cp .env.example .env  # set MARIADB_PASSWORD
docker compose -f docker-compose.mariadb.yml up
```

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `TRAPIC_MARIADB_HOST` | `localhost` | Host |
| `TRAPIC_MARIADB_PORT` | `3306` | Port |
| `TRAPIC_MARIADB_USER` | `trapic` | User |
| `TRAPIC_MARIADB_PASSWORD` | — | Password |
| `TRAPIC_MARIADB_DATABASE` | `trapic` | Database |

## Authentication

Open by default (localhost, no auth needed). Enable user management by setting an admin password:

```bash
TRAPIC_ADMIN_PASSWORD=my-secret docker compose up
```

Then open `http://localhost:3000/admin` to create users and teams.

### How auth works

| State | Behavior |
|-------|----------|
| No users, no admin password | **Open mode** — all requests accepted |
| Admin password set, no users yet | Open mode — create users at `/admin` |
| Users exist in database | **Bearer token required** (`sk-...`) |

### Users and API keys

1. Open Admin UI (`/admin`)
2. Create user — gets auto-generated API key (`sk-...`)
3. Configure MCP client with the key:

```json
{
  "mcpServers": {
    "trapic": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer sk-a1b2c3d4..."
      }
    }
  }
}
```

API keys are stored as SHA-256 hashes. The plaintext key is shown only once at creation.

### Teams

Users in the same team can see each other's traces.

```
Team: backend-team
  ├── alice (sees bob's traces)
  └── bob   (sees alice's traces)
```

A user can belong to multiple teams.

### Admin API

All endpoints require `Authorization: Bearer <TRAPIC_ADMIN_PASSWORD>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/api/users` | List users |
| `POST` | `/admin/api/users` | Create user |
| `DELETE` | `/admin/api/users/:id` | Delete user |
| `POST` | `/admin/api/users/:id/regenerate` | Regenerate API key |
| `GET` | `/admin/api/teams` | List teams |
| `POST` | `/admin/api/teams` | Create team |
| `DELETE` | `/admin/api/teams/:id` | Delete team |
| `GET` | `/admin/api/teams/:id/members` | List members |
| `POST` | `/admin/api/teams/:id/members` | Add member |
| `DELETE` | `/admin/api/teams/:id/members/:userId` | Remove member |

## Deployment

### Docker

```bash
# SQLite (default)
docker compose up

# PostgreSQL
docker compose -f docker-compose.postgres.yml up

# MariaDB
docker compose -f docker-compose.mariadb.yml up
```

### Kubernetes

Manifests in `k8s/`.

**SQLite** (single replica):
```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

**MariaDB** (scalable):
```bash
# Create secret first (copy from example, fill in passwords)
cp k8s/mariadb-secret.example.yaml k8s/mariadb-secret.yaml
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/mariadb-secret.yaml
kubectl apply -f k8s/mariadb.yaml
kubectl apply -f k8s/deployment-mariadb.yaml
kubectl apply -f k8s/service.yaml
```

### Node.js

```bash
npm install && npm run build && npm start
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `TRAPIC_PORT` | `3000` | Server port |
| `TRAPIC_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose) |
| `TRAPIC_DB_ADAPTER` | `sqlite` | `sqlite`, `postgres`, or `mariadb` |
| `TRAPIC_DB` | `./data/trapic.db` | SQLite database path |
| `TRAPIC_USER` | `local-user` | Default user ID (open mode) |
| `TRAPIC_ADMIN_PASSWORD` | — | Enables Admin UI at `/admin` |

## Architecture

```
┌─────────────┐                    ┌──────────────┐                  ┌──────────────┐
│  AI Client  │  ── MCP/HTTP ──►   │ Trapic Core  │  ── adapter ──►  │   Database   │
│ Claude Code │  POST /mcp         │  MCP Server  │                  │ SQLite / PG  │
│ Cursor, etc │  ◄── JSON ──       │              │                  │  / MariaDB   │
└─────────────┘                    └──────────────┘                  └──────────────┘
```

- **Protocol**: [Model Context Protocol](https://modelcontextprotocol.io) (Streamable HTTP)
- **Search**: Structured tags + full-text search, no embeddings
- **Decay**: Type-specific half-lives (state: 30d, decision: 90d, convention: 180d, fact: 365d)
- **Security**: API keys hashed (SHA-256), admin rate limiting, constant-time auth comparison

## Cloud Version

Don't want to self-host? [trapic.ai](https://trapic.ai) offers a managed version with OAuth login and team collaboration.

Use the [Trapic Plugin](https://github.com/nickjazz/trapic-plugin) for one-click setup.

## License

MIT
