import { afterEach, describe, expect, it, vi } from 'vitest';

const { appsFindOne, appsUpdateOne, usersFindOne, usersUpdateOne } = vi.hoisted(() => ({
  appsFindOne: vi.fn(),
  appsUpdateOne: vi.fn(),
  usersFindOne: vi.fn(),
  usersUpdateOne: vi.fn(),
}));

vi.mock('../src/db', () => ({
  col: {
    apps: { findOne: appsFindOne, updateOne: appsUpdateOne },
    users: { findOne: usersFindOne, updateOne: usersUpdateOne },
  },
}));

import { ensureDemoApp } from '../src/bootstrap';

afterEach(() => vi.clearAllMocks());

describe('ensureDemoApp — fresh-install-only guard', () => {
  it('does nothing when the app registry already has an app', async () => {
    // The guard's findOne({}) returns a real app -> established deployment.
    appsFindOne.mockResolvedValueOnce({ key: 'real-app' });
    const res = await ensureDemoApp('admin@example.com');
    expect(res).toBeUndefined();
    expect(appsUpdateOne).not.toHaveBeenCalled(); // no demo upsert -> can't resurrect on restart
  });

  it('seeds the demo app on a fresh (empty) registry', async () => {
    appsFindOne
      .mockResolvedValueOnce(null) // guard: no apps yet
      .mockResolvedValueOnce(null) // existing-demo lookup
      .mockResolvedValueOnce({ key: 'demo', proxy_secret: 'sek' }); // final read for the return
    usersFindOne.mockResolvedValue(null); // no superadmin row to grant to
    const res = await ensureDemoApp('admin@example.com');
    expect(appsUpdateOne).toHaveBeenCalledTimes(1); // the demo upsert ran
    expect(res).toBe('sek');
  });
});
