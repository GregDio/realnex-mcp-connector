# RealNex MCP Server

A Model Context Protocol (MCP) connector for the **RealNex SyncAPI Data
Facade** (RealNex CRM). It runs two ways: as a **local** stdio server for a
desktop app, or as a **remote** Streamable HTTP server (e.g. on Render) that
claude.ai, Cowork, and other MCP clients can reach by URL. It reads `realnex-api.json` (the RealNex OpenAPI/Swagger
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
  OData search endpoints (`CrmOData/*`) get `filter`, `orderby`, `select`,
  `expand`, `top`, `skip`, `count` added automatically. They are exposed
  without the `$` prefix (some MCP clients reject `$` in property names) and
  mapped back to `$filter`, `$top`, etc. when the request is sent.
- `src/naming.ts` — turns each `operationId` (or method+path, for the few
  operations missing one) into a stable, unique, snake_case tool name
  (e.g. `realnex_put_edit_company`).
- `src/tools.ts` — converts each `Operation` into an MCP tool definition
  (name, description, JSON Schema input).
- `src/client.ts` — executes the actual HTTP call: substitutes path params,
  builds the query string, attaches the JSON (or `merge-patch+json`) body,
  adds the `Authorization` header, and normalizes the response (JSON, text,
  or base64 for binary/file downloads).
- `src/index.ts` — wires it all into an MCP `Server`, over Streamable HTTP
  (default) or stdio (`MCP_TRANSPORT=stdio`).

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

`npm start` runs `dist/index.js` directly. Environment variables must be set
in the process environment — e.g. via your shell, or your MCP client's config
or hosting dashboard. Never commit tokens to the repo.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `REALNEX_TOKEN` | one of `REALNEX_TOKEN` or the username/password pair | Bearer JWT for the SyncAPI |
| `REALNEX_USERNAME` / `REALNEX_PASSWORD` | see above | Falls back to HTTP Basic auth if no token is set |
| `REALNEX_BASE_URL` | no | Overrides the API base URL. Defaults to `https://sync.realnex.com` |
| `MCP_TRANSPORT` | no | `stdio` for a local desktop app. Unset (default) runs the remote HTTP server |
| `MCP_AUTH_TOKEN` | HTTP mode (strongly recommended) | Random secret. The endpoint is served at `/mcp/<MCP_AUTH_TOKEN>`, so only people who know the URL can use it. If unset, the endpoint is open at `/mcp` |
| `PORT` | no | HTTP port (default 3000; hosts like Render set this for you) |

## Deploying as a remote connector (HTTP mode)

Each person runs **their own** instance with **their own** credentials — never
share a running instance's URL, since it acts with the token behind it.

1. Generate a random secret for `MCP_AUTH_TOKEN`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Deploy this repo anywhere that runs Docker (a `Dockerfile` is included).
   On Render: New → Web Service → connect the repo → Language: Docker. Set the
   environment variables `REALNEX_TOKEN` and `MCP_AUTH_TOKEN`. Leave
   `MCP_TRANSPORT` unset.
3. Check `https://<your-service>/health` — it returns `{"status":"ok","tools":160}`.
4. In your MCP client (claude.ai, Cowork, etc.), add a custom connector with
   the URL `https://<your-service>/mcp/<MCP_AUTH_TOKEN>` and authentication
   set to **None** (the secret in the URL is the credential). If the tool list
   looks empty, use the connector's "Refresh tools list" option.

Free hosting tiers sleep when idle, so the first request after a quiet period
can take 30–60 seconds. Sessions are held in memory and are re-created
automatically after a restart.

## Loading it into your desktop app (stdio mode)

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
        "MCP_TRANSPORT": "stdio",
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

- `realnex_get_crmodata_contacts` — OData search over contacts (`filter`, `top`, etc.)
- `realnex_post_contact` / `realnex_put_edit_contact` / `realnex_delete_contact`
- `realnex_get_property_details`, `realnex_post_property`
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
  intercepts TLS, point Node at its CA certificate by adding
  `NODE_EXTRA_CA_CERTS` to the server's `env` block in your desktop app's
  config, e.g.:
  ```json
  "env": {
    "MCP_TRANSPORT": "stdio",
    "REALNEX_TOKEN": "...",
    "NODE_EXTRA_CA_CERTS": "C:\\path\\to\\your-ca-cert.pem"
  }
  ```
- **Desktop app shows the server timing out / failing to connect** — make
  sure `MCP_TRANSPORT` is set to `stdio` in the config. Without it the server
  starts in HTTP mode.
- **Remote connector says "Session not found"** — the host restarted and
  dropped its in-memory sessions. Reconnect or refresh the connector; clients
  re-initialize automatically.
- **A tool call 404s** — double check the `*Key` GUID you passed; RealNex
  keys are UUIDs.

## Regenerating after a spec update

Replace `realnex-api.json` with the newer spec and run `npm run build`
again. Tool names are derived deterministically from `operationId`/method/path,
so existing tool names stay stable across spec updates unless RealNex renames
an operation.
