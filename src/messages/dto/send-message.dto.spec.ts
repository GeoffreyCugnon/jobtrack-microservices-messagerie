import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SendMessageDto } from './send-message.dto';

const parse = (payload: unknown) => {
  const dto = plainToInstance(SendMessageDto, payload, { enableImplicitConversion: false });
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }) };
};

describe('SendMessageDto', () => {
  it('trims surrounding whitespace from content before validation', () => {
    const { dto, errors } = parse({ content: '   hello world   ' });
    expect(errors).toHaveLength(0);
    expect(dto.content).toBe('hello world');
  });

  it('rejects whitespace-only content (empty after trim)', () => {
    const { errors } = parse({ content: '     ' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects content over 5000 chars', () => {
    const { errors } = parse({ content: 'x'.repeat(5001) });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts an optional metadata object', () => {
    const { dto, errors } = parse({ content: 'hi', metadata: { kind: 'note' } });
    expect(errors).toHaveLength(0);
    expect(dto.metadata).toEqual({ kind: 'note' });
  });
});
