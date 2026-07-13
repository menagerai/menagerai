import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { col } from '../db';
import { audit } from '../audit';
import { ApiKey } from '../types';
import { NotFoundError } from './errors';
import { genSecret } from './common';

// Secret format: "dvk_" + 32 random bytes (base64url). Only the sha256 of the
// whole string is stored; the prefix + last-4 are kept for the masked display.
const PREFIX_LEN = 12; // "dvk_" + 8 chars

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function maskedDisplay(key: Pick<ApiKey, 'prefix' | 'last4'>): string {
  return `${key.prefix}…${key.last4}`;
}

function generateSecret(): string {
  return `dvk_${genSecret()}`;
}

// Create a key for `ownerId`. Returns the stored doc plus the one-time plaintext
// secret — the caller shows it once and then it is unrecoverable.
export async function createApiKey(ownerId: ObjectId, nameInput: string): Promise<{ key: ApiKey; secret: string }> {
  const name = String(nameInput || '').trim() || 'Unnamed key';
  const secret = generateSecret();
  const doc: ApiKey = {
    name,
    user_id: ownerId,
    prefix: secret.slice(0, PREFIX_LEN),
    last4: secret.slice(-4),
    token_hash: hashSecret(secret),
    created_at: new Date(),
    last_used_at: null,
    revoked_at: null,
  };
  const r = await col.apiKeys.insertOne(doc);
  doc._id = r.insertedId;
  await audit({ actor_user_id: String(ownerId), action: 'api_key.create', target_type: 'api_key', target_id: String(r.insertedId), after: { name, prefix: doc.prefix } });
  return { key: doc, secret };
}

// Keys are listed per-owner so admins never see each other's. The hash is never
// projected out — it isn't needed for display and shouldn't leave the DB layer.
export function listApiKeys(ownerId: ObjectId): Promise<ApiKey[]> {
  return col.apiKeys.find({ user_id: ownerId }, { projection: { token_hash: 0 } }).sort({ created_at: -1 }).toArray();
}

// Soft-revoke, scoped to the owner so one admin can't revoke another's key.
export async function revokeApiKey(ownerId: ObjectId, id: string): Promise<void> {
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    throw new NotFoundError();
  }
  const r = await col.apiKeys.updateOne({ _id: oid, user_id: ownerId, revoked_at: null }, { $set: { revoked_at: new Date() } });
  if (r.matchedCount === 0) throw new NotFoundError();
  await audit({ actor_user_id: String(ownerId), action: 'api_key.revoke', target_type: 'api_key', target_id: id });
}

// Auth hot path: look up a live (non-revoked) key by the hash of the presented
// secret. Returns null when missing or revoked.
export async function findLiveKeyByHash(hash: string): Promise<ApiKey | null> {
  return col.apiKeys.findOne({ token_hash: hash, revoked_at: null });
}

// Throttled last-used stamp: only writes when the recorded time is older than
// `minIntervalMs`, so a chatty integration doesn't cause a write per request.
export async function touchLastUsed(id: ObjectId, now: Date, minIntervalMs = 60_000): Promise<void> {
  await col.apiKeys.updateOne(
    { _id: id, $or: [{ last_used_at: null }, { last_used_at: { $lt: new Date(now.getTime() - minIntervalMs) } }] },
    { $set: { last_used_at: now } },
  );
}
