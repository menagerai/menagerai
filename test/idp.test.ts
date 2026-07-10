import { afterEach, describe, expect, it, vi } from 'vitest';

const { signInConfigured, providerConfig, provisioningConfigured } = vi.hoisted(() => ({
  signInConfigured: vi.fn(),
  providerConfig: vi.fn(),
  provisioningConfigured: vi.fn(),
}));
vi.mock('../src/idp/config', () => ({ signInConfigured, providerConfig, provisioningConfigured }));

import { getIdentityProvider, resetProvider } from '../src/idp';

afterEach(() => {
  resetProvider();
  vi.clearAllMocks();
});

const withM2m = { endpoint: 'https://x.logto.app', appId: 'a', appSecret: 's', scopes: 'openid', m2m: { appId: 'm', appSecret: 'ms', managementResource: 'r' } };
const signInOnly = { endpoint: 'https://x.logto.app', appId: 'a', appSecret: 's', scopes: 'openid' };

describe('identity-provider selector', () => {
  it('returns null when sign-in is not configured (setup incomplete)', () => {
    signInConfigured.mockReturnValue(false);
    expect(getIdentityProvider()).toBeNull();
  });

  it('returns a Logto provider WITH provisioning when management is configured', () => {
    signInConfigured.mockReturnValue(true);
    providerConfig.mockReturnValue(withM2m);
    const idp = getIdentityProvider();
    expect(idp?.name).toBe('Logto');
    expect(typeof idp?.oidcClient).toBe('function');
    expect(idp?.provisioning).toBeTruthy();
    expect(typeof idp?.provisioning?.createUser).toBe('function');
  });

  it('omits provisioning when management is not configured', () => {
    signInConfigured.mockReturnValue(true);
    providerConfig.mockReturnValue(signInOnly);
    const idp = getIdentityProvider();
    expect(idp?.provisioning).toBeUndefined();
  });

  it('rebuilds from fresh config after resetProvider()', () => {
    signInConfigured.mockReturnValue(true);
    providerConfig.mockReturnValue(signInOnly);
    expect(getIdentityProvider()?.provisioning).toBeUndefined();
    resetProvider();
    providerConfig.mockReturnValue(withM2m);
    expect(getIdentityProvider()?.provisioning).toBeTruthy();
  });
});
