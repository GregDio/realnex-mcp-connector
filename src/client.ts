import type { Operation } from "./spec.js";

export interface RealNexConfig {
  baseUrl: string;
  token?: string;
  username?: string;
  password?: string;
}

export function loadConfigFromEnv(): RealNexConfig {
  const baseUrl = (process.env.REALNEX_BASE_URL || "https://sync.realnex.com").replace(/\/+$/, "");
  const token = process.env.REALNEX_TOKEN;
  const username = process.env.REALNEX_USERNAME;
  const password = process.env.REALNEX_PASSWORD;

  if (!token && !(username && password)) {
    throw new Error(
      "Missing RealNex credentials. Set REALNEX_TOKEN (bearer JWT) or REALNEX_USERNAME + REALNEX_PASSWORD in the environment."
    );
  }

  return { baseUrl, token, username, password };
}

function authHeader(config: RealNexConfig): string {
  if (config.token) return `Bearer ${config.token}`;
  const basic = Buffer.from(`${config.username}:${config.password}`).toString("base64");
  return `Basic ${basic}`;
}

export interface ToolCallResult {
  status: number;
  statusText: string;
  contentType: string | null;
  isBinary: boolean;
  bodyText?: string;
  bodyJson?: unknown;
  bodyBase64?: string;
}

function isBinaryContentType(ct: string | null): boolean {
  if (!ct) return false;
  return ct.includes("application/octet-stream") || ct.startsWith("image/") || ct.startsWith("application/pdf");
}

export async function callOperation(
  op: Operation,
  args: Record<string, any>,
  config: RealNexConfig
): Promise<ToolCallResult> {
  let path = op.path;
  for (const p of op.pathParams) {
    const value = args[p.name];
    if (value === undefined || value === null) {
      throw new Error(`Missing required path parameter: ${p.name}`);
    }
    path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
  }

  const fullUrl = new URL(config.baseUrl + path);

  for (const p of op.queryParams) {
    const value = args[p.name];
    if (value === undefined || value === null) continue;
    const qname = p.queryName ?? p.name;
    if (Array.isArray(value)) {
      for (const v of value) fullUrl.searchParams.append(qname, String(v));
    } else {
      fullUrl.searchParams.append(qname, String(value));
    }
  }

  const headers: Record<string, string> = {
    Authorization: authHeader(config),
    Accept: "application/json",
  };

  let body: string | undefined;
  if (op.requestBodySchema) {
    if (args.body !== undefined) {
      headers["Content-Type"] = op.requestBodyContentType || "application/json";
      body = JSON.stringify(args.body);
    } else if (op.requestBodyRequired) {
      throw new Error(`Missing required request body for ${op.toolName}`);
    }
  }

  const res = await fetch(fullUrl, {
    method: op.method.toUpperCase(),
    headers,
    body,
  });

  const contentType = res.headers.get("content-type");
  const result: ToolCallResult = {
    status: res.status,
    statusText: res.statusText,
    contentType,
    isBinary: isBinaryContentType(contentType),
  };

  if (result.isBinary) {
    const buf = Buffer.from(await res.arrayBuffer());
    result.bodyBase64 = buf.toString("base64");
  } else if (contentType?.includes("json")) {
    const text = await res.text();
    try {
      result.bodyJson = text ? JSON.parse(text) : null;
    } catch {
      result.bodyText = text;
    }
  } else {
    result.bodyText = await res.text();
  }

  return result;
}
