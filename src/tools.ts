import type { Operation } from "./spec.js";
import type { JsonSchema } from "./schema.js";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

function buildDescription(op: Operation): string {
  const parts = [op.summary, `\n\n${op.method.toUpperCase()} ${op.path}`, `Category: ${op.tag}`];
  if (op.isOData) {
    parts.push(
      "Supports OData query parameters ($filter, $orderby, $select, $expand, $top, $skip, $count) for searching/filtering."
    );
  }
  return parts.join("\n");
}

export function operationToTool(op: Operation): McpToolDef {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const p of [...op.pathParams, ...op.queryParams]) {
    properties[p.name] = {
      ...p.schema,
      description: p.description ?? p.schema.description,
    };
    if (p.required) required.push(p.name);
  }

  if (op.requestBodySchema) {
    properties.body = op.requestBodySchema;
    if (op.requestBodyRequired) required.push("body");
  }

  const inputSchema: JsonSchema = {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };

  return {
    name: op.toolName,
    description: buildDescription(op),
    inputSchema,
  };
}
