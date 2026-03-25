# Trapic Core — Self-Hosted AI Knowledge Memory Engine

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE) [![MCP](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io)

> **Long-term memory for AI coding assistants. Self-hosted, SQLite-backed, zero vendor dependencies.**

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

### Connect your AI tool

Add to your `.mcp.json` (Claude Code, Cursor, etc.):

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

## MCP Tools

| Tool | Description |
|------|-------------|
| `trapic-create` | Create a knowledge trace (decision, convention, fact, state, preference) |
| `trapic-search` | Search by tags, keywords, type, time range |
| `trapic-recall` | Session briefing — load project foundations and recent activity |
| `trapic-update` | Update trace content, status, or supersede old traces |
| `trapic-get` | Get a trace by ID |
| `trapic-health` | Project health report — type distribution, decay status |
| `trapic-decay` | Scan for stale knowledge based on type-specific TTLs |
| `trapic-import-git` | Import knowledge from git commit history |

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
┌─────────────┐     MCP/HTTP      ┌──────────────┐     SQLite     ┌──────────┐
│  AI Client  │ ◄───────────────► │ Trapic Core  │ ◄────────────► │ trapic.db│
│ Claude Code │     localhost      │  MCP Server  │                └──────────┘
│ Cursor, etc │                   └──────────────┘
└─────────────┘
```

- **Transport**: HTTP with MCP protocol (Streamable HTTP)
- **Storage**: SQLite via `better-sqlite3` — zero setup, file-based
- **Auth**: Localhost-only by default — no token needed for self-hosted
- **Deployment**: Docker or bare Node.js

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `TRAPIC_PORT` | `3000` | Server port |
| `TRAPIC_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose) |
| `TRAPIC_DB` | `./data/trapic.db` | SQLite database path |
| `TRAPIC_USER` | `local-user` | Default user ID |

## Cloud Version

Don't want to self-host? [trapic.ai](https://trapic.ai) offers a hosted version with team collaboration and managed infrastructure.

Use the [Trapic Plugin](https://github.com/nickjazz/trapic-plugin) for one-click setup with the cloud version.

## License

MIT
