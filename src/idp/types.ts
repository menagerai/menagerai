import { Client } from 'openid-client';

// User provisioning INTO the IdP (optional capability — present only when the
// provider's management API is configured). The call sites in services/users.ts
// impose their own failure policy (create/delete hard, update/suspend soft).
export interface Provisioning {
  createUser(input: { email: string; name?: string }): Promise<{ id: string }>;
  updateUser(idpUserId: string, input: { name?: string }): Promise<void>;
  deleteUser(idpUserId: string): Promise<void>;
  setSuspended(idpUserId: string, suspended: boolean): Promise<void>;
}

// The seam every identity provider implements. Sign-in is delegated to an
// OIDC-certified IdP (we never store credentials); provisioning is optional and
// degrades gracefully. Logto is the one predefined implementation today.
export interface IdentityProvider {
  readonly name: string; // human-facing (setup UI / logs), e.g. "Logto"
  oidcClient(): Promise<Client>;
  userinfo(bearer: string): Promise<{ sub: string; email?: string } | null>;
  provisioning?: Provisioning;
}
