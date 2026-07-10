import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ insertOne: vi.fn() }));
vi.mock('../src/db', () => ({ col: { audit: { insertOne: h.insertOne } } }));

import { audit } from '../src/audit';
import { runWithAuditContext } from '../src/audit-context';

beforeEach(() => {
  vi.clearAllMocks();
  h.insertOne.mockResolvedValue({});
});

describe('audit channel stamping', () => {
  it('defaults to a UI action with no api key', async () => {
    await audit({ action: 'user.create', actor_user_id: 'a' });
    const doc = h.insertOne.mock.calls[0][0];
    expect(doc.via).toBe('ui');
    expect(doc.api_key_id).toBeUndefined();
    expect(doc.api_key_name).toBeUndefined();
  });

  it('stamps via=api and the key when inside an API audit context', async () => {
    await runWithAuditContext({ via: 'api', apiKeyId: 'k1', apiKeyName: 'ci-bot' }, async () => {
      await audit({ action: 'user.delete', actor_user_id: 'a', target_id: 'u9' });
    });
    const doc = h.insertOne.mock.calls[0][0];
    expect(doc.via).toBe('api');
    expect(doc.api_key_id).toBe('k1');
    expect(doc.api_key_name).toBe('ci-bot');
    // The action itself is recorded exactly as a normal activity.
    expect(doc.action).toBe('user.delete');
    expect(doc.actor_user_id).toBe('a');
  });

  it('does not leak the API context to a later UI action', async () => {
    await runWithAuditContext({ via: 'api', apiKeyId: 'k1' }, async () => {
      await audit({ action: 'role.create', actor_user_id: 'a' });
    });
    await audit({ action: 'role.delete', actor_user_id: 'a' });
    expect(h.insertOne.mock.calls[1][0].via).toBe('ui');
  });
});
