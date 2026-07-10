import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { providerConfig, provisioningConfigured, refreshProviderConfig, signInConfigured } from '../src/idp/config';

const ENV = ['LOGTO_ENDPOINT', 'LOGTO_APP_ID', 'LOGTO_APP_SECRET', 'LOGTO_M2M_APP_ID', 'LOGTO_M2M_APP_SECRET', 'LOGTO_MANAGEMENT_API_RESOURCE'];

beforeEach(() => ENV.forEach((k) => delete process.env[k]));
afterEach(() => ENV.forEach((k) => delete process.env[k]));

describe('provider-config resolver (env-only)', () => {
  it('resolves sign-in config from env and strips a trailing slash', () => {
    process.env.LOGTO_ENDPOINT = 'https://env.logto.app/';
    process.env.LOGTO_APP_ID = 'env-app';
    process.env.LOGTO_APP_SECRET = 'env-secret';
    refreshProviderConfig();
    expect(signInConfigured()).toBe(true);
    expect(providerConfig()?.endpoint).toBe('https://env.logto.app');
    expect(providerConfig()?.appId).toBe('env-app');
  });

  it('is unconfigured when the core LOGTO_* vars are absent', () => {
    refreshProviderConfig();
    expect(signInConfigured()).toBe(false);
    expect(providerConfig()).toBeNull();
  });

  it('has sign-in but no provisioning without the M2M triple', () => {
    process.env.LOGTO_ENDPOINT = 'https://env.logto.app';
    process.env.LOGTO_APP_ID = 'env-app';
    process.env.LOGTO_APP_SECRET = 'env-secret';
    refreshProviderConfig();
    expect(signInConfigured()).toBe(true);
    expect(provisioningConfigured()).toBe(false);
  });

  it('enables provisioning when the full M2M triple is present', () => {
    process.env.LOGTO_ENDPOINT = 'https://env.logto.app';
    process.env.LOGTO_APP_ID = 'env-app';
    process.env.LOGTO_APP_SECRET = 'env-secret';
    process.env.LOGTO_M2M_APP_ID = 'm2m';
    process.env.LOGTO_M2M_APP_SECRET = 'm2m-secret';
    process.env.LOGTO_MANAGEMENT_API_RESOURCE = 'https://env.logto.app/api';
    refreshProviderConfig();
    expect(provisioningConfigured()).toBe(true);
    expect(providerConfig()?.m2m?.appSecret).toBe('m2m-secret');
  });
});
