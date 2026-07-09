import { afterEach, describe, expect, it } from 'vitest';
import { decryptSecret, encryptionAvailable, encryptSecret } from '../src/crypto';

const KEY = 'test-encryption-key-please-change';

afterEach(() => {
  delete process.env.APP_ENCRYPTION_KEY;
});

describe('crypto — AES-256-GCM secret storage', () => {
  it('round-trips a secret and does not store it in the clear', () => {
    process.env.APP_ENCRYPTION_KEY = KEY;
    const blob = encryptSecret('s3cr3t-value');
    expect(blob.ct).not.toContain('s3cr3t');
    expect(blob.iv).toBeTruthy();
    expect(blob.tag).toBeTruthy();
    expect(decryptSecret(blob)).toBe('s3cr3t-value');
  });

  it('fails to decrypt with a different key (GCM auth)', () => {
    process.env.APP_ENCRYPTION_KEY = KEY;
    const blob = encryptSecret('abc');
    process.env.APP_ENCRYPTION_KEY = 'a-totally-different-key';
    expect(() => decryptSecret(blob)).toThrow();
  });

  it('reports unavailable and throws when no key is set', () => {
    expect(encryptionAvailable()).toBe(false);
    expect(() => encryptSecret('x')).toThrow(/APP_ENCRYPTION_KEY/);
  });
});
