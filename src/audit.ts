import { ObjectId } from 'mongodb';
import { col } from './db';
import { auditContext } from './audit-context';

export async function audit(entry: {
  actor_user_id?: ObjectId | string | null;
  action: string;
  target_type?: string;
  target_id?: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  try {
    // Stamp the channel from the request-scoped context (set by the API auth
    // middleware). No context ⇒ a logged-in admin UI action.
    const ctx = auditContext.getStore();
    const channel = ctx?.via === 'api'
      ? { via: 'api' as const, api_key_id: ctx.apiKeyId, api_key_name: ctx.apiKeyName }
      : { via: 'ui' as const };
    await col.audit.insertOne({ ...entry, ...channel, created_at: new Date() });
  } catch (err) {
    // Auditing must never break the request it records.
    console.error('audit write failed', err);
  }
}
