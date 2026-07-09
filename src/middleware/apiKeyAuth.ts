import { NextFunction, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { col } from '../db';
import { ApiKey } from '../types';
import { runWithAuditContext } from '../audit-context';
import { findLiveKeyByHash, hashSecret, touchLastUsed } from '../services/apiKeys';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKey | null;
    }
  }
}

// Pull the presented secret from either `Authorization: Bearer dvk_…` or the
// `X-API-Key` header.
function presentedSecret(req: Request): string | null {
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  const x = req.get('x-api-key');
  return x ? x.trim() : null;
}

// Authenticate a programmatic admin request by API key. On success it sets
// `req.user` to the key's owner so every downstream service, audit entry and
// authorization check behaves exactly as for a logged-in admin. The owner's
// admin standing is re-checked on every call, so revoking the system_admin role
// or disabling the account immediately disables all of that admin's keys.
export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const secret = presentedSecret(req);
    if (!secret) {
      res.status(401).json({ error: 'missing_api_key', detail: 'Provide an API key via "Authorization: Bearer <key>" or the X-API-Key header.' });
      return;
    }
    const key = await findLiveKeyByHash(hashSecret(secret));
    if (!key) {
      res.status(401).json({ error: 'invalid_api_key' });
      return;
    }
    const owner = await col.users.findOne({ _id: key.user_id });
    if (!owner || owner.status !== 'active' || !owner.roles?.includes('system_admin')) {
      res.status(403).json({ error: 'key_owner_not_admin', detail: 'The key owner is no longer an active system_admin.' });
      return;
    }
    req.user = owner;
    req.apiKey = key;
    // Best-effort, throttled usage stamp — never blocks the request.
    touchLastUsed(key._id as ObjectId, new Date()).catch((err) => console.error('api key touch failed', err));
    // Run the rest of the request inside an audit context so every audit() the
    // downstream services write is stamped as an API action, attributed to this key.
    runWithAuditContext({ via: 'api', apiKeyId: String(key._id), apiKeyName: key.name }, () => next());
  } catch (err) {
    console.error('api key auth error', err);
    res.status(500).json({ error: 'internal_error' });
  }
}
