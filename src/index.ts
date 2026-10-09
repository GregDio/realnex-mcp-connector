#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
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
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `RealNex API error ${result.status} ${result.statusText}\n${
                typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)
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

      return { content: [{ type: "text", text }] };
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

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", tools: tools.length }));
      return;
    }

    if (url !== mcpPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const bodyText = await readBody(req);
      const parsedBody = bodyText ? JSON.parse(bodyText) : undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (!sessionId) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const server = createMcpServer();
        await server.connect(transport);
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found. Please reinitialize." }));
        return;
      }

      await transport.handleRequest(req, res, parsedBody);
      if (transport.sessionId && !transports.has(transport.sessionId)) {
        transports.set(transport.sessionId, transport);
      }
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found. Please reinitialize." }));
        return;
      }
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  httpServer.listen(port, "0.0.0.0", () => {
    console.error(`RealNex MCP server running (HTTP) on port ${port}: ${tools.length} tools loaded`);
    console.error(`MCP endpoint: ${mcpPath}`);
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
