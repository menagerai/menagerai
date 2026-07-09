import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { settingsFindOne } = vi.hoisted(() => ({ settingsFindOne: vi.fn() }));
vi.mock('../src/db', () => ({ col: { settings: { findOne: settingsFindOne } } }));

import { encryptSecret } from '../src/crypto';
import { providerConfig, provisioningConfigured, refreshProviderConfig, signInConfigured } from '../src/idp/config';

const ENV = ['LOGTO_ENDPOINT', 'LOGTO_APP_ID', 'LOGTO_APP_SECRET', 'LOGTO_M2M_APP_ID', 'LOGTO_M2M_APP_SECRET', 'LOGTO_MANAGEMENT_API_RESOURCE', 'APP_ENCRYPTION_KEY'];

beforeEach(() => {
  settingsFindOne.mockReset();
  ENV.forEach((k) => delete process.env[k]);
});
afterEach(() => ENV.forEach((k) => delete process.env[k]));

describe('provider-config resolver', () => {
  it('resolves from env, and env wins over the settings store', async () => {
    process.env.LOGTO_ENDPOINT = 'https://env.logto.app/';
    process.env.LOGTO_APP_ID = 'env-app';
    process.env.LOGTO_APP_SECRET = 'env-secret';
    settingsFindOne.mockResolvedValue({ key: 'provider', endpoint: 'https://db.logto.app', appId: 'db-app' });
    await refreshProviderConfig();
    expect(signInConfigured()).toBe(true);
    expect(providerConfig()?.endpoint).toBe('https://env.logto.app'); // trailing slash stripped
    expect(providerConfig()?.appId).toBe('env-app');
    expect(settingsFindOne).not.toHaveBeenCalled(); // env short-circuits the DB read
  });

  it('falls back to the settings store and decrypts the secrets', async () => {
    process.env.APP_ENCRYPTION_KEY = 'key-for-test';
    settingsFindOne.mockResolvedValue({
      key: 'provider',
      endpoint: 'https://db.logto.app',
      appId: 'db-app',
      appSecretEnc: encryptSecret('db-secret'),
      m2mAppId: 'm2m',
      m2mAppSecretEnc: encryptSecret('m2m-secret'),
      managementResource: 'https://tenant/api',
    });
    await refreshProviderConfig();
    expect(signInConfigured()).toBe(true);
    expect(provisioningConfigured()).toBe(true);
    expect(providerConfig()?.appSecret).toBe('db-secret');
    expect(providerConfig()?.m2m?.appSecret).toBe('m2m-secret');
  });

  it('is unconfigured with neither env nor a settings doc', async () => {
    settingsFindOne.mockResolvedValue(null);
    await refreshProviderConfig();
    expect(signInConfigured()).toBe(false);
    expect(providerConfig()).toBeNull();
  });

  it('has sign-in but no provisioning when only the core config is present', async () => {
    process.env.APP_ENCRYPTION_KEY = 'key-for-test';
    settingsFindOne.mockResolvedValue({ key: 'provider', endpoint: 'https://db.logto.app', appId: 'db-app', appSecretEnc: encryptSecret('s') });
    await refreshProviderConfig();
    expect(signInConfigured()).toBe(true);
    expect(provisioningConfigured()).toBe(false);
  });
});
