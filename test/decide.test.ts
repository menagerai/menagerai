import { describe, expect, it } from 'vitest';
import { decideFrom } from '../src/decide';
import { AppDoc, Role, User } from '../src/types';

function user(over: Partial<User> = {}): User {
  return {
    email: 'alice@example.com',
    status: 'active',
    source: 'manual',
    roles: [],
    app_overrides: [],
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function app(over: Partial<AppDoc> = {}): AppDoc {
  return {
    key: 'demo',
    name: 'Demo',
    auth_mode: 'proxy',
    status: 'active',
    proxy_secret: 's',
    public_paths: [],
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function role(key: string, grants: { app: string }[]): Role {
  return { key, name: key, grants, created_at: new Date(), updated_at: new Date() };
}

describe('decideFrom — status gate', () => {
  it('denies a null user', () => {
    expect(decideFrom(null, app(), [])).toMatchObject({ allowed: false, reason: 'no_user' });
  });
  it('denies a pending user even with a matching grant', () => {
    const u = user({ status: 'pending', roles: ['r'] });
    const r = role('r', [{ app: 'demo' }]);
    expect(decideFrom(u, app(), [r])).toMatchObject({ allowed: false, reason: 'inactive' });
  });
  it('denies a disabled user even with a user allow override', () => {
    const u = user({
      status: 'disabled',
      app_overrides: [{ app: 'demo', effect: 'allow', created_at: new Date() }],
    });
    expect(decideFrom(u, app(), [])).toMatchObject({ allowed: false, reason: 'inactive' });
  });
  it('denies when the app is unknown (null)', () => {
    expect(decideFrom(user(), null, [])).toMatchObject({ allowed: false, reason: 'unknown_app' });
  });
  it('denies when the app is disabled', () => {
    expect(decideFrom(user(), app({ status: 'disabled' }), [])).toMatchObject({
      allowed: false,
      reason: 'unknown_app',
    });
  });
});

describe('decideFrom — precedence (binary access)', () => {
  it('user deny beats a user allow for the same app', () => {
    const u = user({
      app_overrides: [
        { app: 'demo', effect: 'allow', created_at: new Date() },
        { app: 'demo', effect: 'deny', created_at: new Date() },
      ],
    });
    expect(decideFrom(u, app(), [])).toMatchObject({ allowed: false, reason: 'deny_user' });
  });

  it('user deny beats a role allow', () => {
    const u = user({
      roles: ['r'],
      app_overrides: [{ app: 'demo', effect: 'deny', created_at: new Date() }],
    });
    const r = role('r', [{ app: 'demo' }]);
    expect(decideFrom(u, app(), [r])).toMatchObject({ allowed: false, reason: 'deny_user' });
  });

  it('user allow grants access (as allow_user)', () => {
    const u = user({
      roles: ['r'],
      app_overrides: [{ app: 'demo', effect: 'allow', created_at: new Date() }],
    });
    const r = role('r', [{ app: 'demo' }]);
    expect(decideFrom(u, app(), [r])).toMatchObject({ allowed: true, reason: 'allow_user' });
  });

  it('role allow is the normal path when there is no override', () => {
    const u = user({ roles: ['r'] });
    const r = role('r', [{ app: 'demo' }]);
    expect(decideFrom(u, app(), [r])).toMatchObject({ allowed: true, reason: 'allow_role' });
  });

  it('grants from any one of several roles suffice', () => {
    const u = user({ roles: ['a', 'b'] });
    const roles = [role('a', []), role('b', [{ app: 'demo' }])];
    expect(decideFrom(u, app(), roles)).toMatchObject({ allowed: true, reason: 'allow_role' });
  });

  it('defaults to deny with no override and no grant', () => {
    expect(decideFrom(user({ roles: ['r'] }), app(), [role('r', [])])).toMatchObject({
      allowed: false,
      reason: 'no_grant',
    });
  });

  it('the decision carries no app role or permissions (access is binary)', () => {
    const u = user({ roles: ['r'] });
    const d = decideFrom(u, app(), [role('r', [{ app: 'demo' }])]);
    expect(d).not.toHaveProperty('app_role');
    expect(d).not.toHaveProperty('permissions');
  });
});

describe('decideFrom — isolation between apps', () => {
  it('ignores an override that targets a different app', () => {
    const u = user({
      app_overrides: [{ app: 'finance', effect: 'allow', created_at: new Date() }],
    });
    expect(decideFrom(u, app({ key: 'demo' }), [])).toMatchObject({ allowed: false, reason: 'no_grant' });
  });
  it('ignores a grant that targets a different app', () => {
    const u = user({ roles: ['r'] });
    const r = role('r', [{ app: 'finance' }]);
    expect(decideFrom(u, app({ key: 'demo' }), [r])).toMatchObject({ allowed: false, reason: 'no_grant' });
  });
});
