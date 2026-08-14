/**
 * Shared JSON-schema sanitization for tool definitions.
 *
 * Tools contributed by VS Code may carry `$ref`/`$defs`/`$id`/`$schema` keys
 * and recursive references that some upstream OpenCode endpoints reject. This
 * flattens a tool schema into a minimal, safe `{ type, properties, required }`
 * shape shared by the OpenAI, Anthropic and Google request builders.
 *
 * CONTRACT: pure functions only — no `vscode` import, no side effects.
 */
import { isRecord } from "../utils";

export function sanitizeToolSchema(schema: unknown): object {
  const root = isRecord(schema) ? schema : { type: "object", properties: {} };
  const sanitized = sanitizeJsonSchemaNode(root, root, new Set());
  if (!isRecord(sanitized)) {
    return { type: "object", properties: {} };
  }

  return {
    type: "object",
    properties: isRecord(sanitized.properties) ? sanitized.properties : {},
    ...(Array.isArray(sanitized.required) ? { required: sanitized.required } : {}),
  };
}

function sanitizeJsonSchemaNode(value: unknown, root: Record<string, unknown>, seenRefs: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonSchemaNode(item, root, seenRefs));
  }

  if (!isRecord(value)) {
    return value;
  }

  const ref = typeof value.$ref === "string" ? value.$ref : undefined;
  if (ref?.startsWith("#/") && !seenRefs.has(ref)) {
    const target = resolveJsonPointer(root, ref);
    if (target !== undefined) {
      const nextSeenRefs = new Set(seenRefs);
      nextSeenRefs.add(ref);
      const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
      const resolved = sanitizeJsonSchemaNode(target, root, nextSeenRefs);
      return isRecord(resolved)
        ? sanitizeJsonSchemaNode({ ...resolved, ...siblings }, root, nextSeenRefs)
        : sanitizeJsonSchemaNode(siblings, root, nextSeenRefs);
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || key === "$id" || key === "$ref" || key === "$defs" || key === "definitions") {
      continue;
    }

    if (key === "properties" && isRecord(child)) {
      result.properties = Object.fromEntries(
        Object.entries(child).map(([propertyName, propertySchema]) => [
          propertyName,
          sanitizeJsonSchemaNode(propertySchema, root, seenRefs),
        ]),
      );
      continue;
    }

    if (key === "items" || key === "additionalProperties") {
      result[key] = sanitizeJsonSchemaNode(child, root, seenRefs);
      continue;
    }

    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(child)) {
      result[key] = child.map((item) => sanitizeJsonSchemaNode(item, root, seenRefs));
      continue;
    }

    if (["type", "description", "enum", "required", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"].includes(key)) {
      result[key] = child;
    }
  }

  return result;
}

function resolveJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
  return pointer
    .slice(2)
    .split("/")
    .reduce<unknown>((current, segment) => {
      if (!isRecord(current)) {
        return undefined;
      }
      return current[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    }, root);
}
