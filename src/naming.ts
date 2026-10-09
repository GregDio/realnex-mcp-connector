// Turns OpenAPI operationIds / method+path pairs into stable, unique,
// MCP-friendly tool names (snake_case, prefixed, deduplicated).

function pascalToSnake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function pathToSlug(path: string): string {
  return path
    .replace(/^\/api\/v1\//i, "")
    .replace(/^\/api\//i, "")
    .replace(/[{}]/g, "")
    .replace(/[/]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .toLowerCase();
}

export function baseToolName(method: string, path: string, operationId?: string): string {
  let base: string;
  if (operationId) {
    base = pascalToSnake(operationId.replace(/Async$/, ""));
  } else {
    base = `${method.toLowerCase()}_${pathToSlug(path)}`;
  }
  base = base.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return `realnex_${base}`;
}

/** Ensures unique tool names by suffixing the HTTP method on collision. */
export class NameDeduper {
  private used = new Set<string>();

  claim(preferred: string, method: string): string {
    if (!this.used.has(preferred)) {
      this.used.add(preferred);
      return preferred;
    }
    const withMethod = `${preferred}_${method.toLowerCase()}`;
    if (!this.used.has(withMethod)) {
      this.used.add(withMethod);
      return withMethod;
    }
    let n = 2;
    let candidate = `${withMethod}_${n}`;
    while (this.used.has(candidate)) {
      n += 1;
      candidate = `${withMethod}_${n}`;
    }
    this.used.add(candidate);
    return candidate;
  }
}
