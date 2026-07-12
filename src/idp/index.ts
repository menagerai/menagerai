import { generators } from 'openid-client';
import { config } from '../config';
import { providerConfig, signInConfigured } from './config';
import { createLogtoProvider } from './logto';
import { IdentityProvider } from './types';

// PKCE/state/nonce helpers are library-level, provider-independent.
export { generators };
export type { IdentityProvider, Provisioning } from './types';

let cached: IdentityProvider | null = null;

// The active identity provider, or null when none is configured (first-run setup
// not yet complete). Logto is the one predefined provider; a future provider would
// be selected here based on the resolved config's shape.
export function getIdentityProvider(): IdentityProvider | null {
  // Demo mode never contacts a real IdP, even if LOGTO_* happen to be set: sign-in
  // is the persona picker (src/demo/auth.ts) and provisioning is a no-op. Returning
  // null here makes every downstream call site (auth, provisioning) degrade safely.
  if (config.demoMode) return null;
  if (!signInConfigured()) {
    cached = null;
    return null;
  }
  if (cached) return cached;
  const cfg = providerConfig();
  if (!cfg) return null;
  cached = createLogtoProvider(cfg);
  return cached;
}

// Drop the cached provider (and its cached OIDC client) after provider config
// changes — e.g. the first-run wizard writing new config — so the next resolve
// rebuilds from fresh config without a restart.
export function resetProvider(): void {
  cached = null;
}
