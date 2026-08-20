/**
 * Convert Dark Kitchen's plain JSON Schema tool descriptors into Zod schemas
 * for the MCP SDK (which requires Zod-compatible schemas, not raw JSON Schema).
 */

import { z } from 'zod';

type JsonSchema = {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly description?: string;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
};

/** Convert one JSON Schema property descriptor to a Zod type. */
function toZod(schema: JsonSchema | undefined, required: boolean): z.ZodTypeAny {
  let result: z.ZodTypeAny;
  switch (schema?.type) {
    case 'string':
      if (schema.enum) {
        const values = schema.enum.map((v) => String(v));
        result = values.length > 0 ? z.enum(values as [string, ...string[]]) : z.never();
      } else {
        let stringSchema = z.string();
        if (schema.minLength !== undefined) stringSchema = stringSchema.min(schema.minLength);
        if (schema.maxLength !== undefined) stringSchema = stringSchema.max(schema.maxLength);
        result = stringSchema;
      }
      break;
    case 'integer': {
      let numberSchema = z.number().int();
      if (schema.minimum !== undefined) numberSchema = numberSchema.min(schema.minimum);
      if (schema.maximum !== undefined) numberSchema = numberSchema.max(schema.maximum);
      result = numberSchema;
      break;
    }
    case 'number':
      {
        let numberSchema = z.number();
        if (schema.minimum !== undefined) numberSchema = numberSchema.min(schema.minimum);
        if (schema.maximum !== undefined) numberSchema = numberSchema.max(schema.maximum);
        result = numberSchema;
      }
      break;
    case 'boolean':
      result = z.boolean();
      break;
    case 'array': {
      // Array elements are values, not optional object properties.
      let arraySchema = z.array(toZod(schema.items, true));
      if (schema.minItems !== undefined) arraySchema = arraySchema.min(schema.minItems);
      if (schema.maxItems !== undefined) arraySchema = arraySchema.max(schema.maxItems);
      result = arraySchema;
      break;
    }
    case 'object': {
      if (!schema.properties) {
        result = z.record(z.string(), z.unknown());
        break;
      }
      const propertyRequired = new Set(schema.required ?? []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [name, property] of Object.entries(schema.properties)) {
        shape[name] = toZod(property, propertyRequired.has(name));
      }
      result =
        schema.additionalProperties === true
          ? z.object(shape).passthrough()
          : z.object(shape).strict();
      break;
    }
    default:
      result = z.unknown();
      break;
  }
  if (schema?.description) result = result.describe(schema.description);
  if (!required) result = result.optional();
  return result;
}

/** Build a Zod object schema from a JSON Schema tool descriptor. */
export function zodSchemaFromJsonSchema(
  inputSchema: JsonSchema | undefined,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  if (!inputSchema || inputSchema.type !== 'object' || !inputSchema.properties) {
    return z.object({}).strict();
  }
  const required = new Set(inputSchema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, property] of Object.entries(inputSchema.properties)) {
    shape[name] = toZod(property, required.has(name));
  }
  return inputSchema.additionalProperties === true
    ? z.object(shape).passthrough()
    : z.object(shape).strict();
}
