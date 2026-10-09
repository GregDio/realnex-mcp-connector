// Minimal, self-contained OpenAPI JSON-Schema resolver.
// Inlines `$ref` pointers into components/schemas so every generated MCP
// tool ships a fully self-contained JSON Schema (MCP clients do not resolve
// internal $ref pointers). Cyclic refs are cut off with a plain object stub.

export type JsonSchema = Record<string, any>;

const MAX_DEPTH = 6;

export class SchemaResolver {
  constructor(private readonly components: { schemas: Record<string, JsonSchema> }) {}

  private refName(ref: string): string {
    const parts = ref.split("/");
    return parts[parts.length - 1];
  }

  /** Recursively inline a schema (or $ref), cutting cycles/deep nesting. */
  resolve(schema: JsonSchema | undefined, stack: string[] = [], depth = 0): JsonSchema {
    if (!schema) return {};

    if (schema.$ref) {
      const name = this.refName(schema.$ref);
      if (stack.includes(name) || depth >= MAX_DEPTH) {
        return {
          type: "object",
          description: `${name} (nested reference omitted to keep the schema finite; see RealNex API docs for full shape)`,
          additionalProperties: true,
        };
      }
      const target = this.components.schemas[name];
      if (!target) {
        return { type: "object", additionalProperties: true, description: `Unresolved schema ref: ${schema.$ref}` };
      }
      return this.resolve(target, [...stack, name], depth + 1);
    }

    const out: JsonSchema = {};
    if (schema.type) out.type = schema.type;
    if (schema.format) out.format = schema.format;
    if (schema.description) out.description = schema.description;
    if (schema.enum) out.enum = schema.enum;
    if (schema.default !== undefined) out.default = schema.default;
    if (schema.nullable) {
      // JSON Schema draft-07 (used by MCP clients) has no `nullable` keyword;
      // express it as a type union instead.
      const baseType = schema.type ?? (schema.$ref ? undefined : "object");
      if (baseType) out.type = Array.isArray(baseType) ? [...baseType, "null"] : [baseType, "null"];
    }

    if (schema.type === "array" || schema.items) {
      out.type = "array";
      out.items = this.resolve(schema.items, stack, depth + 1);
    }

    if (schema.type === "object" || schema.properties) {
      out.type = "object";
      if (schema.properties) {
        out.properties = {};
        for (const [key, value] of Object.entries<JsonSchema>(schema.properties)) {
          out.properties[key] = this.resolve(value, stack, depth + 1);
        }
      }
      if (schema.required) out.required = schema.required;
      if (schema.additionalProperties !== undefined) {
        out.additionalProperties =
          typeof schema.additionalProperties === "object"
            ? this.resolve(schema.additionalProperties, stack, depth + 1)
            : schema.additionalProperties;
      }
    }

    for (const combiner of ["allOf", "oneOf", "anyOf"] as const) {
      if (schema[combiner]) {
        out[combiner] = schema[combiner].map((s: JsonSchema) => this.resolve(s, stack, depth + 1));
      }
    }

    if (!out.type && !schema.enum && !schema.properties && !schema.items && Object.keys(out).length === 0) {
      out.type = "object";
      out.additionalProperties = true;
    }

    return out;
  }
}
