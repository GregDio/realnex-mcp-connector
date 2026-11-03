#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadSpec, parseOperations, type Operation } from "./spec.js";
import { operationToTool } from "./tools.js";
import { callOperation, loadConfigFromEnv } from "./client.js";

const spec = loadSpec();
const allOperations = parseOperations(spec);

const maxTools = process.env.MCP_MAX_TOOLS ? parseInt(process.env.MCP_MAX_TOOLS, 10) : Infinity;
const operations = maxTools < allOperations.length ? allOperations.slice(0, maxTools) : allOperations;

const opsByToolName = new Map<string, Operation>(operations.map((op) => [op.toolName, op]));
const tools = operations.map(operationToTool);

// Likely causes for RealNex errors, from RealNex's "Common Errors" support article.
function errorHint(op: Operation, status: number, hasBody: boolean): string {
  const name = op.toolName;
  switch (status) {
    case 400:
      return "Check for a $filter field that doesn't exist, a wrong value type, a value over the field's length limit, a country that isn't a two-letter code, top over 100, or an unquoted GUID in a filter. The response body usually names the field.";
    case 401:
      return "The token is missing, wrong or no longer valid. Generate a new one.";
    case 404:
      return "The path is wrong or the record doesn't exist. Common case: /contact/{key}/details should be /contact/{key}/personal.";
    case 415:
      return "Updates must be sent as application/merge-patch+json.";
    case 500:
      if (hasBody) return "";
      if (name === "realnex_post_object_history")
        return "This one-step endpoint is known to fail. Create the record with realnex_post_history, then link it with realnex_post_history_objects (body: [{key, type}]).";
      return (
        (/history/.test(name) ? "History subjects are limited to 100 characters. " : "") +
        (/event_objects|history_objects/.test(name)
          ? "Link bodies are an array of {key, type}, with type one of Contact, Company, Property, Space, SaleComp, LeaseComp, Project. "
          : "") +
        "Empty 500s usually mean a request problem that should have been a 400. Common causes: " +
        (/event/.test(name) ? "an event created without priorityKey (always send it, e.g. 0 for Normal); " : "") +
        "a link body using objectKey instead of key, or missing type; a custom text value over 100 characters; " +
        "LastActivity eq null in a filter (use LastActivity/StartDate eq null)."
      );
    default:
      return "";
  }
}

// Known RealNex issue (KRM API: Updating records): a contact update can silently switch off
// "Use company address". Appended to successful contact updates so it isn't missed.
const CONTACT_UPDATE_NOTE =
  "\n\nNote: a 200 only means the request was accepted. Known RealNex issue: updating a contact " +
  "that uses its company's address turns off 'Use company address' (address goes blank) with no warning. " +
  "Re-check that setting in KRM for this contact. Notes, custom fields (/personal), investor criteria, " +
  "history and events are not affected. Read the record back to confirm the changes saved.";

function createMcpServer(): Server {
  const server = new Server(
    { name: "realnex-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const op = opsByToolName.get(request.params.name);
    if (!op) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      };
    }

    try {
      const config = loadConfigFromEnv();
      const args = (request.params.arguments ?? {}) as Record<string, any>;
      const result = await callOperation(op, args, config);

      if (result.status >= 400) {
        const detail = result.bodyJson ?? result.bodyText ?? "";
        const detailText = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
        const hint = errorHint(op, result.status, detailText.trim().length > 0);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `RealNex API error ${result.status} ${result.statusText}\n${detailText}${
                hint ? `\nHint: ${hint}` : ""
              }`,
            },
          ],
        };
      }

      if (result.isBinary && result.bodyBase64) {
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `data:${result.contentType ?? "application/octet-stream"};base64,${result.bodyBase64}`,
                mimeType: result.contentType ?? "application/octet-stream",
                blob: result.bodyBase64,
              },
            },
          ],
        };
      }

      const text =
        result.bodyJson !== undefined
          ? JSON.stringify(result.bodyJson, null, 2)
          : result.bodyText ?? "(empty response)";

      const note = op.toolName === "realnex_put_edit_contact" ? CONTACT_UPDATE_NOTE : "";
      return { content: [{ type: "text", text: text + note }] };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error calling ${op.toolName}: ${err?.message ?? String(err)}` }],
      };
    }
  });

  return server;
}

async function startStdio() {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`RealNex MCP server running (stdio): ${tools.length} tools loaded`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function startHttp() {
  const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
  if (!MCP_AUTH_TOKEN) {
    console.error("WARNING: MCP_AUTH_TOKEN is not set. The MCP endpoint is unprotected. Serving at /mcp");
  }

  const mcpPath = MCP_AUTH_TOKEN ? `/mcp/${MCP_AUTH_TOKEN}` : "/mcp";

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", tools: tools.length }));
      return;
    }

    const hdr = (n: string) => (req.headers[n] ? "y" : "n");
    const logReq = (rpc: string, status: number) =>
      console.error(
        `mcp ${req.method} rpc=${rpc} status=${status} accept=${hdr("accept")} pv=${req.headers["mcp-protocol-version"] ?? "-"} sid=${hdr("mcp-session-id")} ua=${String(req.headers["user-agent"] ?? "-").slice(0, 60)}`
      );

    if (url !== mcpPath) {
      if (url.startsWith("/mcp")) console.error(`mcp ${req.method} path-mismatch status=404`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (req.method !== "POST") {
      logReq("-", 405);
      res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Stateless: a fresh server + transport per request, so a restart can never strand a client.
    // Any mcp-session-id the client sends is simply ignored.
    try {
      const bodyText = await readBody(req);
      const parsedBody = bodyText ? JSON.parse(bodyText) : undefined;
      const server = createMcpServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
      }
      const webReq = new Request(`http://${req.headers.host ?? "localhost"}${url}`, {
        method: "POST",
        headers,
        body: bodyText,
      });
      const webRes = await transport.handleRequest(webReq, { parsedBody });
      const out = Buffer.from(await webRes.arrayBuffer());
      const outHeaders: Record<string, string> = {};
      webRes.headers.forEach((v, k) => (outHeaders[k] = v));
      delete outHeaders["transfer-encoding"];
      outHeaders["content-length"] = String(out.length);
      res.writeHead(webRes.status, outHeaders);
      res.end(out);
      logReq(Array.isArray(parsedBody) ? "batch" : String(parsedBody?.method ?? "-"), webRes.status);
      await transport.close();
      await server.close();
    } catch (err: any) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  httpServer.listen(port, "0.0.0.0", () => {
    console.error(`RealNex MCP server running (HTTP) on port ${port}: ${tools.length} tools loaded`);
    console.error(`MCP endpoint: ${MCP_AUTH_TOKEN ? "/mcp/<MCP_AUTH_TOKEN>" : mcpPath}`);
  });
}

const mode = process.env.MCP_TRANSPORT ?? "http";

if (mode === "stdio") {
  startStdio().catch((err) => {
    console.error("Fatal error starting RealNex MCP server (stdio):", err);
    process.exit(1);
  });
} else {
  startHttp().catch((err) => {
    console.error("Fatal error starting RealNex MCP server (HTTP):", err);
    process.exit(1);
  });
}
