// {{variable}} interpolation engine
// Resolves references like {{trends}}, {{config.threshold}}, {{input.sourceUrl}}

const VAR_PATTERN = /\{\{([^}]+)\}\}/g;

export function interpolate(template: string, variables: Record<string, unknown>): string {
  return template.replace(VAR_PATTERN, (_, path: string) => {
    const resolved = resolvePath(path.trim(), variables);
    if (resolved === undefined || resolved === null) return `{{${path.trim()}}}`;
    if (typeof resolved === "object") return JSON.stringify(resolved);
    return String(resolved);
  });
}

export function interpolateParams(
  params: Record<string, unknown>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      result[key] = interpolate(value, variables);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = interpolateParams(value as Record<string, unknown>, variables);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function resolvePath(path: string, variables: Record<string, unknown>): unknown {
  // Handle array indexing: "items[0].name"
  const segments = path.split(/\.|\[|\]/).filter(Boolean);

  let current: unknown = variables;
  for (const segment of segments) {
    if (current == null) return undefined;
    if (typeof current !== "object") return undefined;

    const index = Number(segment);
    if (!isNaN(index) && Array.isArray(current)) {
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}
