# RealNex MCP Server

A local Model Context Protocol (MCP) connector for the **RealNex SyncAPI Data
Facade** (RealNex CRM). It reads `realnex-api.json` (the RealNex OpenAPI/Swagger
spec) at startup and dynamically generates one MCP tool per API operation —
160 tools covering contacts, companies, properties, spaces, projects, lease
comps, sale comps, events, history, attachments, object groups, and OData
search across all major entities.

Because the tools are generated from the spec rather than hand-written, the
server automatically picks up new/changed operations whenever you drop in an
updated `realnex-api.json` and rebuild — no code changes required.

## How it's built

- `src/schema.ts` — resolves OpenAPI `$ref` schemas into self-contained JSON
  Schema (with cycle/depth protection), since MCP clients don't dereference
  internal `$ref`s.
- `src/spec.ts` — walks every path/method in the spec and builds an
  `Operation` for each, including path/query params and request body schema.
  OData search endpoints (`CrmOData/*`) get `$filter`, `$orderby`, `$select`,
  `$expand`, `$top`, `$skip`, `$count` added automatically.
- `src/naming.ts` — turns each `operationId` (or method+path, for the few
  operations missing one) into a stable, unique, snake_case tool name
  (e.g. `realnex_put_edit_company`).
- `src/tools.ts` — converts each `Operation` into an MCP tool definition
  (name, description, JSON Schema input).
- `src/client.ts` — executes the actual HTTP call: substitutes path params,
  builds the query string, attaches the JSON (or `merge-patch+json`) body,
  adds the `Authorization` header, and normalizes the response (JSON, text,
  or base64 for binary/file downloads).
- `src/index.ts` — wires it all into an MCP `Server` over stdio.

## Prerequisites

- Node.js 18+ (tested with Node 24)
- A RealNex account with SyncAPI access, and either:
  - a **bearer token** (JWT) for the SyncAPI, or
  - your RealNex **username/password** (sent as HTTP Basic auth — the spec
    supports both `Bearer` and `Basic` schemes)

Check with your RealNex administrator or RealNex support for how your
organization issues SyncAPI tokens if you don't already have one.

## Setup

```bash
npm install
npm run build
```

This compiles `src/` to `dist/` and copies `realnex-api.json` alongside it.

Copy `.env.example` to `.env` for local/manual testing (`npm start` loads
`dist/index.js` directly; env vars must be present in the process
environment — e.g. via your shell, a `.env` loader, or your MCP client's
config).

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `REALNEX_TOKEN` | one of `REALNEX_TOKEN` or the username/password pair | Bearer JWT for the SyncAPI |
| `REALNEX_USERNAME` / `REALNEX_PASSWORD` | see above | Falls back to HTTP Basic auth if no token is set |
| `REALNEX_BASE_URL` | no | Overrides the API base URL. Defaults to `https://sync.realnex.com`, which this project verified live during setup (`GET /api/v1/Crm/countries` returns a proper `401 Unauthorized` from that host, confirming it's the real API) |

## Loading it into your desktop app

Add an entry to your MCP client's server config (for Claude Desktop, that's
`claude_desktop_config.json` under `%APPDATA%\Claude\` on Windows). A ready
template is in [`claude_desktop_config.example.json`](claude_desktop_config.example.json):

```json
{
  "mcpServers": {
    "realnex": {
      "command": "node",
      "args": [
        "C:\\path\\to\\realnex-mcp-connector\\dist\\index.js"
      ],
      "env": {
        "REALNEX_TOKEN": "PASTE_YOUR_REALNEX_API_TOKEN_HERE"
      }
    }
  }
}
```

Merge this into your existing config's `mcpServers` object (don't overwrite
other entries), then restart the desktop app.

## Tool naming

Every tool is prefixed `realnex_`, e.g.:

- `realnex_get_crmodata_contacts` — OData search over contacts (`$filter`, `$top`, etc.)
- `realnex_post_contact` / `realnex_put_edit_contact` / `realnex_delete_contact`
- `realnex_get_property_full`, `realnex_post_property`
- `realnex_get_object_attachments`, `realnex_post_attachment`
- `realnex_get_history`, `realnex_post_history`
- `realnex_get_object_group`, `realnex_post_object_group`

Path parameters (e.g. `contactKey`) and query parameters are top-level tool
inputs; request bodies (for POST/PUT) are nested under a `body` field
matching the RealNex schema for that operation.

## Troubleshooting

- **`RealNex API error 401 Unauthorized`** — your `REALNEX_TOKEN` (or
  username/password) is missing, expired, or invalid.
- **`fetch failed` with no HTTP status** — usually a TLS/network issue, not
  an API problem. If your machine runs an antivirus or corporate proxy that
  intercepts TLS (this dev machine has Norton doing this, requiring
  `NODE_EXTRA_CA_CERTS`), add the same CA-related environment variables to
  the server's `env` block in your desktop app's config, e.g.:
  ```json
  "env": {
    "REALNEX_TOKEN": "...",
    "NODE_EXTRA_CA_CERTS": "C:\\ProgramData\\Norton\\Antivirus\\wscert.pem"
  }
  ```
- **A tool call 404s** — double check the `*Key` GUID you passed; RealNex
  keys are UUIDs.

## Regenerating after a spec update

Replace `realnex-api.json` with the newer spec and run `npm run build`
again. Tool names are derived deterministically from `operationId`/method/path,
so existing tool names stay stable across spec updates unless RealNex renames
an operation.
