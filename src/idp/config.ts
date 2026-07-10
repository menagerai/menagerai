// The identity-provider configuration resolver. Provider config comes solely from
// the LOGTO_* env vars (their presence and the live Logto connections are validated
// at boot — see src/startup.ts). It is resolved into a module cache at boot
// (refreshProviderConfig, called from connect()) so the synchronous gates below are
// populated before any request; the app never re-reads process.env after boot, so
// this cache is the single live source of provider config.

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

// (Re)resolve provider config into the cache from the environment.
export function refreshProviderConfig(): void {
  cache = fromEnv();
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
