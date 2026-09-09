import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { ContentCipherService } from './content-cipher.service';

const makeConfig = (key?: string) =>
  ({ get: jest.fn().mockReturnValue(key) }) as unknown as ConfigService;

describe('ContentCipherService', () => {
  const key = randomBytes(32).toString('base64');

  it('round-trips content when a key is configured', () => {
    const cipher = new ContentCipherService(makeConfig(key));
    const stored = cipher.encrypt('hello 🌍');

    expect(cipher.enabled).toBe(true);
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain('hello');
    expect(cipher.decrypt(stored)).toBe('hello 🌍');
  });

  it('produces a different ciphertext each call (random IV)', () => {
    const cipher = new ContentCipherService(makeConfig(key));
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('is a pass-through when no key is configured', () => {
    const cipher = new ContentCipherService(makeConfig(undefined));

    expect(cipher.enabled).toBe(false);
    expect(cipher.encrypt('plain')).toBe('plain');
    expect(cipher.decrypt('plain')).toBe('plain');
  });

  it('still reads legacy clear-text rows once a key is added', () => {
    const cipher = new ContentCipherService(makeConfig(key));
    expect(cipher.decrypt('written before encryption was enabled')).toBe(
      'written before encryption was enabled',
    );
  });

  it('throws on a v1: row when the key is missing', () => {
    const withKey = new ContentCipherService(makeConfig(key));
    const stored = withKey.encrypt('secret');
    const noKey = new ContentCipherService(makeConfig(undefined));

    expect(() => noKey.decrypt(stored)).toThrow(/not set/);
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const cipher = new ContentCipherService(makeConfig(key));
    const stored = cipher.encrypt('secret');
    const tampered = `${stored.slice(0, -4)}AAAA`;

    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('rejects a key of the wrong length', () => {
    expect(() => new ContentCipherService(makeConfig(randomBytes(16).toString('base64')))).toThrow(
      /32 bytes/,
    );
  });
});
