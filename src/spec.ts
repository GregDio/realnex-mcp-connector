import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SchemaResolver, type JsonSchema } from "./schema.js";
import { baseToolName, NameDeduper } from "./naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ParamDef {
  name: string;
  in: "path" | "query";
  required: boolean;
  schema: JsonSchema;
  description?: string;
  queryName?: string;
}

export interface Operation {
  toolName: string;
  method: HttpMethod;
  path: string;
  tag: string;
  summary: string;
  operationId?: string;
  pathParams: ParamDef[];
  queryParams: ParamDef[];
  requestBodySchema?: JsonSchema;
  requestBodyRequired: boolean;
  requestBodyContentType?: string;
  isOData: boolean;
}

function pickRequestBodyContentType(content: Record<string, any>): string {
  if (content["application/merge-patch+json"]) return "application/merge-patch+json";
  if (content["application/json"]) return "application/json";
  return Object.keys(content)[0];
}

export function loadSpec(specPath?: string): any {
  if (specPath) return JSON.parse(readFileSync(specPath, "utf8"));
  const candidates = [
    join(__dirname, "realnex-api.json"),
    join(__dirname, "..", "realnex-api.json"),
  ];
  for (const p of candidates) {
    try { return JSON.parse(readFileSync(p, "utf8")); } catch {}
  }
  throw new Error(`realnex-api.json not found in ${candidates.join(" or ")}`);
}

const ODATA_PARAMS: ParamDef[] = [
  {
    name: "filter",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "OData $filter expression, e.g. \"contains(fullName,'Smith') and doNotEmail eq false\"",
    queryName: "$filter",
  },
  {
    name: "orderby",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "OData $orderby sort expression, e.g. \"lastName asc, firstName asc\"",
    queryName: "$orderby",
  },
  {
    name: "select",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "OData $select — comma-separated list of fields to return, e.g. \"key,fullName,email\"",
    queryName: "$select",
  },
  {
    name: "expand",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "OData $expand — comma-separated list of navigation properties to expand",
    queryName: "$expand",
  },
  {
    name: "top",
    in: "query",
    required: false,
    schema: { type: "integer" },
    description: "OData $top — maximum number of records to return (page size)",
    queryName: "$top",
  },
  {
    name: "skip",
    in: "query",
    required: false,
    schema: { type: "integer" },
    description: "OData $skip — number of records to skip (for paging)",
    queryName: "$skip",
  },
  {
    name: "count",
    in: "query",
    required: false,
    schema: { type: "boolean" },
    description: "OData $count — if true, includes a total count of matching records",
    queryName: "$count",
  },
];

export function parseOperations(spec: any): Operation[] {
  const resolver = new SchemaResolver(spec.components);
  const deduper = new NameDeduper();
  const operations: Operation[] = [];

  for (const [path, pathItem] of Object.entries<any>(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const def = pathItem[method];
      if (!def) continue;

      const pathParams: ParamDef[] = [];
      const queryParams: ParamDef[] = [];
      for (const p of def.parameters ?? []) {
        if (p.name === "api-version") continue; // defaulted server-side; not user-facing
        const paramDef: ParamDef = {
          name: p.name,
          in: p.in,
          required: !!p.required,
          schema: resolver.resolve(p.schema),
          description: p.description || undefined,
        };
        if (p.in === "path") pathParams.push(paramDef);
        else if (p.in === "query") queryParams.push(paramDef);
      }

      const isOData = (def.tags ?? []).includes("CrmOData");
      if (isOData) queryParams.push(...ODATA_PARAMS);

      let requestBodySchema: JsonSchema | undefined;
      let requestBodyContentType: string | undefined;
      if (def.requestBody?.content) {
        requestBodyContentType = pickRequestBodyContentType(def.requestBody.content);
        const bodySchema = def.requestBody.content[requestBodyContentType]?.schema;
        requestBodySchema = resolver.resolve(bodySchema);
      }

      const tag = (def.tags ?? ["RealNex"])[0];
      const preferredName = baseToolName(method, path, def.operationId);
      const toolName = deduper.claim(preferredName, method);

      operations.push({
        toolName,
        method,
        path,
        tag,
        summary: def.summary || def.operationId || `${method.toUpperCase()} ${path}`,
        operationId: def.operationId,
        pathParams,
        queryParams,
        requestBodySchema,
        requestBodyRequired: !!def.requestBody?.required,
        requestBodyContentType,
        isOData,
      });
    }
  }

  return operations;
}
