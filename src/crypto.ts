import crypto from 'crypto';
import { EncryptedBlob } from './types';

// AES-256-GCM encryption for the few secrets persisted in the settings store
// (provider app secret + M2M secret captured by the first-run wizard). The key is
// derived from APP_ENCRYPTION_KEY via scrypt with a fixed domain-separation salt —
// the env value is the actual secret, so a per-blob random salt buys nothing and
// would only need storing. Env vars remain the primary config path; this exists so
// UI-captured secrets are not readable from a raw DB dump.
const ALGO = 'aes-256-gcm';
const SALT = 'menagerai/settings/v1'; // domain separation, not secret

let cached: { raw: string; key: Buffer } | null = null;
function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('APP_ENCRYPTION_KEY is not set — required to store or read encrypted provider secrets.');
  }
  if (!cached || cached.raw !== raw) cached = { raw, key: crypto.scryptSync(raw, SALT, 32) };
  return cached.key;
}

// Whether in-app secret storage is possible (i.e. the operator set a key). The
// setup wizard uses this to offer the env-only path when no key is configured.
export function encryptionAvailable(): boolean {
  return Boolean(process.env.APP_ENCRYPTION_KEY);
}

export function encryptSecret(plain: string): EncryptedBlob {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

export function decryptSecret(blob: EncryptedBlob): string {
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]).toString('utf8');
}
