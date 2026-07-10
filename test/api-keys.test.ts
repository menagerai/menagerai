import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal db stubs — the api-key paths only touch these collections.
const h = vi.hoisted(() => ({
  keyInsertOne: vi.fn(),
  keyFindOne: vi.fn(),
  keyUpdateOne: vi.fn(),
  userFindOne: vi.fn(),
}));

vi.mock('../src/db', () => ({
  col: {
    apiKeys: { insertOne: h.keyInsertOne, findOne: h.keyFindOne, updateOne: h.keyUpdateOne },
    users: { findOne: h.userFindOne },
  },
}));
vi.mock('../src/audit', () => ({ audit: vi.fn() }));

import { createApiKey, hashSecret, maskedDisplay } from '../src/services/apiKeys';
import { requireApiKey } from '../src/middleware/apiKeyAuth';

beforeEach(() => {
  vi.clearAllMocks();
  h.keyInsertOne.mockResolvedValue({ insertedId: new ObjectId() });
  h.keyUpdateOne.mockResolvedValue({ matchedCount: 1 });
});

describe('apiKeys service', () => {
  it('masks as prefix…last4', () => {
    expect(maskedDisplay({ prefix: 'dvk_Ab12Cd', last4: 'wxyz' })).toBe('dvk_Ab12Cd…wxyz');
  });

  it('stores only the hash, never the plaintext secret', async () => {
    const owner = new ObjectId();
    const { key, secret } = await createApiKey(owner, 'ci-bot');

    expect(secret.startsWith('dvk_')).toBe(true);
    const doc = h.keyInsertOne.mock.calls[0][0];
    // The plaintext must not be persisted anywhere on the document.
    expect(JSON.stringify(doc)).not.toContain(secret);
    expect(doc.token_hash).toBe(hashSecret(secret));
    expect(doc.token_hash).toBe(crypto.createHash('sha256').update(secret).digest('hex'));
    expect(doc.prefix).toBe(secret.slice(0, 12));
    expect(doc.last4).toBe(secret.slice(-4));
    expect(doc.user_id).toBe(owner);
    expect(doc.revoked_at).toBeNull();
    expect(key.name).toBe('ci-bot');
  });
});

function runMiddleware(headers: Record<string, string>) {
  const req: any = { get: (k: string) => headers[k.toLowerCase()] };
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(o: unknown) { this.body = o; return this; },
  };
  const next = vi.fn();
  return { promise: requireApiKey(req, res, next), req, res, next };
}

describe('requireApiKey', () => {
  it('401s when no key is presented', async () => {
    const { promise, res, next } = runMiddleware({});
    await promise;
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('missing_api_key');
    expect(next).not.toHaveBeenCalled();
  });

  it('401s on an unknown/revoked key', async () => {
    h.keyFindOne.mockResolvedValue(null); // findLiveKeyByHash excludes revoked
    const { promise, res, next } = runMiddleware({ authorization: 'Bearer dvk_whatever' });
    await promise;
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('invalid_api_key');
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when the key owner is no longer an active admin', async () => {
    h.keyFindOne.mockResolvedValue({ _id: new ObjectId(), user_id: new ObjectId() });
    h.userFindOne.mockResolvedValue({ _id: new ObjectId(), status: 'active', roles: ['ext_sales'] });
    const { promise, res, next } = runMiddleware({ 'x-api-key': 'dvk_whatever' });
    await promise;
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('authenticates a valid key and attaches the owner as req.user', async () => {
    const owner = { _id: new ObjectId(), status: 'active', roles: ['system_admin'] };
    const key = { _id: new ObjectId(), user_id: owner._id };
    h.keyFindOne.mockResolvedValue(key);
    h.userFindOne.mockResolvedValue(owner);
    const { promise, req, next } = runMiddleware({ authorization: 'Bearer dvk_good' });
    await promise;
    expect(next).toHaveBeenCalled();
    expect(req.user).toBe(owner);
    expect(req.apiKey).toBe(key);
  });
});
