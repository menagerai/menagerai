import { Client, Issuer } from 'openid-client';
import { config, redirectUri } from '../config';
import { ProviderConfig } from './config';
import { IdentityProvider, Provisioning } from './types';

// Logto — the one predefined IdentityProvider. Holds all Logto-specific shapes
// (the `/oidc` discovery suffix, the ES384 id-token default, the `/oidc/me`
// userinfo endpoint, and the Management API paths) behind the generic interface.
// Built from a resolved ProviderConfig (from the LOGTO_* env vars) — see idp/config.ts.
export function createLogtoProvider(cfg: ProviderConfig): IdentityProvider {
  let cachedClient: Client | null = null;

  async function oidcClient(): Promise<Client> {
    if (cachedClient) return cachedClient;
    const issuer = await Issuer.discover(`${cfg.endpoint}/oidc`);
    // Register a callback for every portal host (all aliases of this one tenant).
    const redirectUris = Array.from(new Set([redirectUri(), ...config.portalHosts.map((h) => `https://${h}/callback`)]));
    // openid-client expects RS256 by default, but Logto signs with ES384 by
    // default. The per-app alg isn't reliably derivable from discovery, so default
    // to ES384 and allow an explicit override.
    const idTokenAlg = cfg.idTokenAlg || 'ES384';
    cachedClient = new issuer.Client({
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      redirect_uris: redirectUris,
      response_types: ['code'],
      id_token_signed_response_alg: idTokenAlg,
    });
    return cachedClient;
  }

  // Verify a token via userinfo (avoids local JWKS handling); callers cache it.
  async function userinfo(bearer: string): Promise<{ sub: string; email?: string } | null> {
    const res = await fetch(`${cfg.endpoint}/oidc/me`, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!res.ok) return null;
    return (await res.json()) as { sub: string; email?: string };
  }

  let provisioning: Provisioning | undefined;
  if (cfg.m2m) {
    const m2m = cfg.m2m;
    let mgmtToken: { value: string; expiresAt: number } | null = null;
    const token = async (): Promise<string> => {
      const now = Date.now();
      if (mgmtToken && mgmtToken.expiresAt - 30_000 > now) return mgmtToken.value;
      const body = new URLSearchParams({ grant_type: 'client_credentials', resource: m2m.managementResource, scope: 'all' });
      const basic = Buffer.from(`${m2m.appId}:${m2m.appSecret}`).toString('base64');
      const res = await fetch(`${cfg.endpoint}/oidc/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
        body,
      });
      if (!res.ok) throw new Error(`Logto token request failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { access_token: string; expires_in: number };
      mgmtToken = { value: json.access_token, expiresAt: now + json.expires_in * 1000 };
      return mgmtToken.value;
    };
    const mgmt = async (path: string, init: RequestInit): Promise<Response> => {
      const t = await token();
      return fetch(`${cfg.endpoint}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, ...(init.headers || {}) },
      });
    };
    provisioning = {
      async createUser(input) {
        const res = await mgmt('/api/users', { method: 'POST', body: JSON.stringify({ primaryEmail: input.email, name: input.name }) });
        if (!res.ok) throw new Error(`Create Logto user failed: ${res.status} ${await res.text()}`);
        return (await res.json()) as { id: string };
      },
      async updateUser(id, input) {
        const res = await mgmt(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ name: input.name ?? '' }) });
        if (!res.ok) throw new Error(`Update Logto user failed: ${res.status} ${await res.text()}`);
      },
      async deleteUser(id) {
        const res = await mgmt(`/api/users/${id}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new Error(`Delete Logto user failed: ${res.status} ${await res.text()}`);
      },
      async setSuspended(id, suspended) {
        const res = await mgmt(`/api/users/${id}/is-suspended`, { method: 'PATCH', body: JSON.stringify({ isSuspended: suspended }) });
        if (!res.ok) throw new Error(`Suspend Logto user failed: ${res.status} ${await res.text()}`);
      },
    };
  }

  return { name: 'Logto', oidcClient, userinfo, provisioning };
}
