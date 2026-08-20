import { describe, expect, it } from 'vitest';
import { zodSchemaFromJsonSchema } from './schema.js';

describe('JSON Schema to Zod conversion', () => {
  const schema = zodSchemaFromJsonSchema({
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 1, maximum: 3 },
      labels: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
      nested: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
      },
    },
    required: ['id', 'count', 'labels', 'nested'],
  });

  it('validates nested objects, array elements, integers, and bounds', () => {
    expect(
      schema.safeParse({ id: 'x', count: 2, labels: ['safe'], nested: { enabled: true } }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ id: 'x', count: 1.5, labels: ['safe'], nested: { enabled: true } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ id: 'x', count: 4, labels: ['safe'], nested: { enabled: true } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ id: 'x', count: 2, labels: [''], nested: { enabled: true } }).success,
    ).toBe(false);
    expect(schema.safeParse({ id: 'x', count: 2, labels: ['safe'], nested: {} }).success).toBe(
      false,
    );
  });

  it('rejects undeclared top-level and nested properties by default', () => {
    expect(
      schema.safeParse({
        id: 'x',
        count: 2,
        labels: ['safe'],
        nested: { enabled: true, injected: 'value' },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        id: 'x',
        count: 2,
        labels: ['safe'],
        nested: { enabled: true },
        shell: '$(touch /tmp/should-not-run)',
      }).success,
    ).toBe(false);
  });

  it('allows explicit free-form config payload objects', () => {
    const freeForm = zodSchemaFromJsonSchema({
      type: 'object',
      properties: {
        patch: { type: 'object' },
      },
      required: ['patch'],
    });
    expect(freeForm.safeParse({ patch: { workflows: [{ id: 'design' }] } }).success).toBe(true);
  });
});
