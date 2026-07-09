import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { config } from '../config';
import { NotFoundError } from './errors';

// The system_admin role and the configured superadmin account are structural —
// deleting/disabling them could lock everyone out, so they are protected.
export const PROTECTED_ROLE = 'system_admin';

export function isSuperadmin(email: string | undefined): boolean {
  return Boolean(email && email.toLowerCase() === config.superadminEmail);
}

export function genSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// Parse a hex/string id into an ObjectId, throwing NotFound (→ 404) on a malformed
// id, mirroring the UI handlers' "bad id is just a 404" behavior.
export function toOid(id: string): ObjectId {
  try {
    return new ObjectId(id);
  } catch {
    throw new NotFoundError();
  }
}
