import { z } from 'zod';

type JsonObject = Record<string, unknown>;

/** Keywords strict mode does not take everywhere; Zod validates the answer anyway. */
const DROPPED_KEYWORDS = new Set([
  '$schema',
  'default',
  'examples',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

class Unconvertible extends Error {}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

function convertProperties(properties: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, convertNode(value)]));
}

function convertNode(node: unknown): JsonObject {
  if (!isObject(node) || Object.keys(node).length === 0) throw new Unconvertible('empty or non-object schema');
  if ('allOf' in node || 'not' in node || 'prefixItems' in node || 'patternProperties' in node) throw new Unconvertible('unsupported combinator');
  const kept = Object.fromEntries(Object.entries(node).filter(([key]) => !DROPPED_KEYWORDS.has(key)));
  const variants = kept.anyOf ?? kept.oneOf;
  if (Array.isArray(variants)) {
    const rest = Object.fromEntries(Object.entries(kept).filter(([key]) => key !== 'oneOf'));
    return { ...rest, anyOf: variants.map(convertNode) };
  }
  const types = Array.isArray(kept.type) ? kept.type : [kept.type];
  if (types.includes('array')) return { ...kept, items: convertNode(kept.items) };
  if (!types.includes('object')) return kept;
  if (isObject(kept.additionalProperties) || kept.additionalProperties === true) throw new Unconvertible('free-form object');
  const properties = isObject(kept.properties) ? convertProperties(kept.properties) : {};
  return { ...kept, properties, required: Object.keys(properties), additionalProperties: false };
}

/**
 * The JSON schema of a Zod schema in the strict form of Structured Outputs: every object closed (`additionalProperties: false`)
 * with all properties required. Optional properties stay required, because Zod would reject a `null` for them.
 * Returns null when the schema cannot be expressed (free-form objects, tuples, intersections, untyped values): the caller falls back to JSON mode.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonObject | null {
  try {
    const converted = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' }) as JsonObject;
    const { $defs, ...root } = converted;
    if (root.type !== 'object') return null;
    const strict = convertNode(root);
    return isObject($defs) ? { ...strict, $defs: Object.fromEntries(Object.entries($defs).map(([key, value]) => [key, convertNode(value)])) } : strict;
  } catch {
    // Zod cannot represent the schema, or strict mode cannot express it: JSON mode is the fallback
    return null;
  }
}
