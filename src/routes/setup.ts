import { Router } from 'express';
import { Issuer } from 'openid-client';
import { config } from '../config';
import { col } from '../db';
import { encryptionAvailable, encryptSecret } from '../crypto';
import { provisioningConfigured, refreshProviderConfig, signInConfigured } from '../idp/config';
import { resetProvider } from '../idp';
import { ensureDemoApp, ensureSuperadmin, isSetupComplete } from '../bootstrap';
import { SettingsDoc } from '../types';

// First-run setup wizard. Serves while no active system_admin has signed in yet
// (enforced by the guard in app.ts). Captures IdP config (persisted encrypted in the
// settings store), seeds the superadmin, then hands off to a real sign-in that
// claims it. The superadmin identity is pinned to SUPERADMIN_EMAIL (config), so the
// existing isSuperadmin() delete/disable protection stays correct.
export const setupRouter = Router();

async function adminSeeded(): Promise<boolean> {
  return (await col.users.find({ roles: 'system_admin' }).toArray()).length > 0;
}

function envProviderSet(): boolean {
  return Boolean(process.env.LOGTO_ENDPOINT && process.env.LOGTO_APP_ID && process.env.LOGTO_APP_SECRET);
}

function fail(res: import('express').Response, msg: string): void {
  res.redirect('/setup?error=' + encodeURIComponent(msg));
}

setupRouter.get('/setup', async (_req, res) => {
  if (await isSetupComplete()) return res.redirect('/');
  const providerConfigured = signInConfigured();
  const seeded = await adminSeeded();
  let step: 'provider' | 'superadmin' | 'finish' = 'provider';
  if (providerConfigured && !seeded) step = 'superadmin';
  else if (providerConfigured && seeded) step = 'finish';
  res.render('setup', {
    title: 'Setup',
    user: null,
    isAdmin: false,
    step,
    providerName: 'Logto',
    providerConfigured,
    envProvider: envProviderSet(),
    provisioning: provisioningConfigured(),
    encryptionAvailable: encryptionAvailable(),
    superadminEmail: config.superadminEmail,
    error: typeof _req.query.error === 'string' ? _req.query.error : null,
  });
});

setupRouter.post('/setup/provider', async (req, res) => {
  if (await isSetupComplete()) return res.redirect('/');
  if (envProviderSet()) return res.redirect('/setup'); // already configured via env
  if (!encryptionAvailable()) {
    return fail(res, 'Set APP_ENCRYPTION_KEY to store provider secrets in the app, or configure the LOGTO_* env vars instead.');
  }
  const b = req.body || {};
  const endpoint = String(b.endpoint || '').trim().replace(/\/+$/, '');
  const appId = String(b.appId || '').trim();
  const appSecret = String(b.appSecret || '').trim();
  if (!(endpoint && appId && appSecret)) return fail(res, 'Endpoint, App ID and App secret are required.');
  try {
    await Issuer.discover(`${endpoint}/oidc`);
  } catch {
    return fail(res, 'Could not reach the OIDC issuer at that endpoint — check the URL.');
  }

  const doc: SettingsDoc = {
    key: 'provider',
    endpoint,
    appId,
    appSecretEnc: encryptSecret(appSecret),
    scopes: String(b.scopes || '').trim() || 'openid profile email',
    idTokenAlg: String(b.idTokenAlg || '').trim() || undefined,
    updated_at: new Date(),
  };
  const m2mAppId = String(b.m2mAppId || '').trim();
  const m2mAppSecret = String(b.m2mAppSecret || '').trim();
  const managementResource = String(b.managementResource || '').trim();
  if (m2mAppId && m2mAppSecret && managementResource) {
    doc.m2mAppId = m2mAppId;
    doc.m2mAppSecretEnc = encryptSecret(m2mAppSecret);
    doc.managementResource = managementResource;
  }
  await col.settings.updateOne({ key: 'provider' }, { $set: doc }, { upsert: true });
  await refreshProviderConfig();
  resetProvider();
  res.redirect('/setup');
});

setupRouter.post('/setup/superadmin', async (_req, res) => {
  if (await isSetupComplete()) return res.redirect('/');
  if (!signInConfigured()) return res.redirect('/setup');
  await ensureSuperadmin(config.superadminEmail);
  await ensureDemoApp(config.superadminEmail);
  res.redirect('/setup');
});
