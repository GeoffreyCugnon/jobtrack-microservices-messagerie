import { validate } from 'class-validator';
import { MaxJsonSize } from './max-json-size.validator';

class Holder {
  @MaxJsonSize(50)
  metadata?: unknown;

  constructor(metadata?: unknown) {
    this.metadata = metadata;
  }
}

async function errorsFor(value: unknown): Promise<number> {
  return (await validate(new Holder(value))).length;
}

describe('MaxJsonSize', () => {
  it('accepts undefined and null', async () => {
    expect(await errorsFor(undefined)).toBe(0);
    expect(await errorsFor(null)).toBe(0);
  });

  it('accepts a value whose serialized size is within the limit', async () => {
    expect(await errorsFor({ a: 1, b: 'ok' })).toBe(0);
  });

  it('rejects a value whose serialized size exceeds the limit', async () => {
    expect(await errorsFor({ big: 'x'.repeat(100) })).toBe(1);
  });

  it('rejects a non-serializable value (circular reference)', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await errorsFor(circular)).toBe(1);
  });
});
