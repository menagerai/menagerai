import { col } from '../db';
import { decryptSecret } from '../crypto';
import { SettingsDoc } from '../types';

// The identity-provider configuration resolver. Owns ALL provider config, resolved
// from two sources with env taking precedence:
//   1. LOGTO_* env vars (12-factor override) — if the core three are set, they win.
//   2. the `settings` doc (key 'provider') written by the first-run wizard, with
//      secret fields decrypted via APP_ENCRYPTION_KEY.
// Resolved into a module cache at boot (refreshProviderConfig, called from connect())
// and re-resolved after the wizard writes, so UI-captured config takes effect without
// a restart — the app never re-reads process.env after boot, so this cache is the
// single live source of provider config.

export interface ProviderConfig {
  endpoint: string;
  appId: string;
  appSecret: string;
  scopes: string;
  idTokenAlg?: string;
  m2m?: { appId: string; appSecret: string; managementResource: string };
}

let cache: ProviderConfig | null = null;

function fromEnv(): ProviderConfig | null {
  const endpoint = (process.env.LOGTO_ENDPOINT || '').replace(/\/+$/, '');
  const appId = process.env.LOGTO_APP_ID || '';
  const appSecret = process.env.LOGTO_APP_SECRET || '';
  if (!(endpoint && appId && appSecret)) return null;
  const m2mAppId = process.env.LOGTO_M2M_APP_ID || '';
  const m2mAppSecret = process.env.LOGTO_M2M_APP_SECRET || '';
  const managementResource = process.env.LOGTO_MANAGEMENT_API_RESOURCE || '';
  return {
    endpoint,
    appId,
    appSecret,
    scopes: process.env.LOGTO_SCOPES || 'openid profile email',
    idTokenAlg: process.env.LOGTO_ID_TOKEN_ALG || undefined,
    m2m:
      m2mAppId && m2mAppSecret && managementResource
        ? { appId: m2mAppId, appSecret: m2mAppSecret, managementResource }
        : undefined,
  };
}

function fromSettings(doc: SettingsDoc): ProviderConfig | null {
  const endpoint = (doc.endpoint || '').replace(/\/+$/, '');
  if (!(endpoint && doc.appId && doc.appSecretEnc)) return null;
  let m2m: ProviderConfig['m2m'];
  if (doc.m2mAppId && doc.m2mAppSecretEnc && doc.managementResource) {
    m2m = { appId: doc.m2mAppId, appSecret: decryptSecret(doc.m2mAppSecretEnc), managementResource: doc.managementResource };
  }
  return {
    endpoint,
    appId: doc.appId,
    appSecret: decryptSecret(doc.appSecretEnc),
    scopes: doc.scopes || 'openid profile email',
    idTokenAlg: doc.idTokenAlg || undefined,
    m2m,
  };
}

// (Re)resolve provider config into the cache. Env wins; else the settings doc.
export async function refreshProviderConfig(): Promise<void> {
  const env = fromEnv();
  if (env) {
    cache = env;
    return;
  }
  try {
    const doc = await col.settings.findOne({ key: 'provider' });
    cache = doc ? fromSettings(doc) : null;
  } catch (err) {
    // e.g. a stored secret exists but APP_ENCRYPTION_KEY is unset → can't decrypt.
    console.error('provider config: failed to read settings store', err);
    cache = null;
  }
}

export function providerConfig(): ProviderConfig | null {
  return cache;
}

export function signInConfigured(): boolean {
  return cache !== null;
}

export function provisioningConfigured(): boolean {
  return Boolean(cache?.m2m);
}

// Back-compat aliases — these names were previously exported from src/config.ts and
// are called across the app; keeping them avoids churn at every gate call site.
export const logtoConfigured = signInConfigured;
export const managementConfigured = provisioningConfigured;
