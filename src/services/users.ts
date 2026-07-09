import { col } from '../db';
import { audit } from '../audit';
import { evictUser } from '../decide';
import { destroyUserSessions } from '../sessions';
import { emailAllowed, matchEmail } from '../rules';
import { getIdentityProvider } from '../idp';
import { usageDay } from '../usage';
import { validateOverride, validEmail } from '../admin-logic';
import { AppOverride, EmailAllowRule, User } from '../types';
import { ApiError, NotFoundError } from './errors';
import { isSuperadmin, toOid } from './common';

// Shared user-management logic. Each function performs the same
// validate → DB → audit → cache-evict steps the admin UI used to inline, throwing
// ApiError on a precondition failure so the UI can flash it and the API can return
// it as JSON. Reads return the raw documents; the EJS pages layer their view-model
// enrichment (heatmaps, access previews) on top.

export function listUsers(q?: string): Promise<User[]> {
  const filter = q
    ? { $or: [{ email: { $regex: q, $options: 'i' } }, { name: { $regex: q, $options: 'i' } }] }
    : {};
  return col.users.find(filter).sort({ created_at: -1 }).limit(200).toArray();
}

export async function getUser(id: string): Promise<User> {
  const user = await col.users.findOne({ _id: toOid(id) });
  if (!user) throw new NotFoundError();
  return user;
}

export async function createUser(
  input: { email: string; name?: string; department?: string; roles?: string[] },
  actorId: string,
): Promise<{ id: string; email: string; roles: string[] }> {
  const email = String(input.email || '').trim().toLowerCase();
  const name = String(input.name || '').trim();
  const department = String(input.department || '').trim();
  const roles = Array.isArray(input.roles) ? input.roles : input.roles ? [input.roles] : [];

  if (!validEmail(email)) throw new ApiError(400, 'flash.invalidEmail');
  if (!(await emailAllowed(email))) throw new ApiError(400, 'flash.emailNotAllowed');
  if (await col.users.findOne({ email })) throw new ApiError(409, 'flash.userExists');

  let logtoId: string | null = null;
  const prov = getIdentityProvider()?.provisioning;
  if (prov) {
    try {
      const created = await prov.createUser({ email, name: name || undefined });
      logtoId = created.id;
    } catch (err) {
      console.error('idp provision failed', err);
      throw new ApiError(502, 'flash.logtoProvisionFailed');
    }
  }
  const now = new Date();
  const r = await col.users.insertOne({
    email,
    name,
    department,
    status: 'active',
    source: 'manual',
    roles,
    app_overrides: [],
    logto_user_id: logtoId,
    created_by: actorId,
    created_at: now,
    updated_at: now,
    last_login_at: null,
    last_synced_to_logto_at: logtoId ? now : null,
  });
  await audit({ actor_user_id: actorId, action: 'user.create', target_type: 'user', target_id: String(r.insertedId), after: { email, roles } });
  return { id: String(r.insertedId), email, roles };
}

export async function updateProfile(
  id: string,
  input: { name?: string; department?: string },
  actorId: string,
): Promise<{ syncWarning: boolean }> {
  const oid = toOid(id);
  const target = await col.users.findOne({ _id: oid });
  if (!target) throw new NotFoundError();
  const name = String(input.name || '').trim();
  const department = String(input.department || '').trim();
  await col.users.updateOne({ _id: oid }, { $set: { name, department, updated_at: new Date() } });
  await audit({ actor_user_id: actorId, action: 'user.profile', target_type: 'user', target_id: id, before: { name: target.name, department: target.department }, after: { name, department } });
  // Best-effort name sync to Logto (department is portal-only). Local record is
  // already saved; a sync failure is a warning, not a hard error.
  let syncWarning = false;
  const prov = getIdentityProvider()?.provisioning;
  if (prov && target.logto_user_id && name !== (target.name || '')) {
    try {
      await prov.updateUser(target.logto_user_id, { name });
      await col.users.updateOne({ _id: oid }, { $set: { last_synced_to_logto_at: new Date() } });
    } catch (err) {
      console.error('idp name sync failed', err);
      syncWarning = true;
    }
  }
  return { syncWarning };
}

export async function setRoles(id: string, rolesInput: string[] | string, actorId: string): Promise<{ roles: string[] }> {
  const oid = toOid(id);
  const roles = Array.isArray(rolesInput) ? rolesInput : rolesInput ? [rolesInput] : [];
  const before = await col.users.findOne({ _id: oid });
  if (!before) throw new NotFoundError();
  await col.users.updateOne({ _id: oid }, { $set: { roles, updated_at: new Date() } });
  evictUser(id);
  await audit({ actor_user_id: actorId, action: 'user.roles', target_type: 'user', target_id: id, before: before.roles, after: roles });
  return { roles };
}

export async function setOverride(
  id: string,
  input: { app: string; effect: unknown; reason?: string },
  actorId: string,
): Promise<{ override: AppOverride }> {
  const oid = toOid(id);
  if (!(await col.users.findOne({ _id: oid }))) throw new NotFoundError();
  const appKey = String(input.app || '');
  if (!(await col.apps.findOne({ key: appKey }))) throw new ApiError(400, 'flash.unknownApp');
  const v = validateOverride(input.effect);
  if (!v.ok) throw new ApiError(400, v.error, v.vars);
  const override: AppOverride = { app: appKey, ...v.value, reason: String(input.reason || ''), created_by: actorId, created_at: new Date() };
  // Replace any existing override for this app (one override per app).
  await col.users.updateOne({ _id: oid }, { $pull: { app_overrides: { app: appKey } } });
  await col.users.updateOne({ _id: oid }, { $push: { app_overrides: override }, $set: { updated_at: new Date() } });
  evictUser(id);
  await audit({ actor_user_id: actorId, action: 'user.override', target_type: 'user', target_id: id, after: override });
  return { override };
}

export async function deleteOverride(id: string, app: string, actorId: string): Promise<void> {
  const oid = toOid(id);
  const appKey = String(app || '');
  await col.users.updateOne({ _id: oid }, { $pull: { app_overrides: { app: appKey } }, $set: { updated_at: new Date() } });
  evictUser(id);
  await audit({ actor_user_id: actorId, action: 'user.override.delete', target_type: 'user', target_id: id, after: { app: appKey } });
}

export async function disableUser(id: string, actorId: string): Promise<void> {
  const oid = toOid(id);
  const target = await col.users.findOne({ _id: oid });
  if (!target) throw new NotFoundError();
  if (isSuperadmin(target.email)) throw new ApiError(403, 'flash.superadminNoDisable');
  await col.users.updateOne({ _id: oid }, { $set: { status: 'disabled', updated_at: new Date() } });
  await destroyUserSessions(oid); // revoke active sessions
  evictUser(id); // instant offboarding (don't wait out the decision TTL)
  const prov = getIdentityProvider()?.provisioning;
  if (prov && target.logto_user_id) {
    try {
      await prov.setSuspended(target.logto_user_id, true);
    } catch (err) {
      console.error('idp suspend failed', err);
    }
  }
  await audit({ actor_user_id: actorId, action: 'user.disable', target_type: 'user', target_id: id });
}

export async function enableUser(id: string, actorId: string): Promise<void> {
  const oid = toOid(id);
  const target = await col.users.findOne({ _id: oid });
  if (!target) throw new NotFoundError();
  await col.users.updateOne({ _id: oid }, { $set: { status: 'active', updated_at: new Date() } });
  const prov = getIdentityProvider()?.provisioning;
  if (prov && target.logto_user_id) {
    try {
      await prov.setSuspended(target.logto_user_id, false);
    } catch (err) {
      console.error('idp unsuspend failed', err);
    }
  }
  await audit({ actor_user_id: actorId, action: 'user.enable', target_type: 'user', target_id: id });
}

export async function deleteUser(id: string, actorId: string): Promise<void> {
  const oid = toOid(id);
  const target = await col.users.findOne({ _id: oid });
  if (!target) throw new NotFoundError();
  if (isSuperadmin(target.email)) throw new ApiError(403, 'flash.superadminNoDelete');
  // Revoke first, so access is dead even if a later step fails.
  await destroyUserSessions(oid);
  evictUser(id);
  const prov = getIdentityProvider()?.provisioning;
  if (prov && target.logto_user_id) {
    try {
      await prov.deleteUser(target.logto_user_id);
    } catch (err) {
      console.error('idp delete failed', err);
      throw new ApiError(502, 'flash.logtoDeleteFailed');
    }
  }
  await col.users.deleteOne({ _id: oid });
  await col.usageDaily.deleteMany({ user_id: oid }); // drop this user's usage history
  await audit({ actor_user_id: actorId, action: 'user.delete', target_type: 'user', target_id: id, before: { email: target.email, roles: target.roles, logto_user_id: target.logto_user_id } });
}

export interface ImportCounts {
  total: number; created: number; existing: number; invalid: number;
  notAllowed: number; duplicate: number; rulesCreated: number; logtoFailed: number;
}

// Provision users from an already-parsed roster (the UI parses the spreadsheet;
// the API accepts the rows as JSON). Auto-creates exact email-allow rules when
// `autoRule` is set. Non-fatal per-row failures are tallied, never thrown.
export async function importRoster(
  roster: { email: string; name: string }[],
  opts: { role?: string; autoRule?: boolean; source?: string },
  actorId: string,
): Promise<{ counts: ImportCounts; problems: { email: string; reason: string }[]; role: string | null }> {
  const role = String(opts.role || '').trim();
  if (role && (!role.startsWith('ext_') || !(await col.roles.findOne({ key: role })))) {
    throw new ApiError(400, 'flash.importRoleNotExternal');
  }
  const autoRule = Boolean(opts.autoRule);
  const activeRules: EmailAllowRule[] = await col.emailRules.find({ status: 'active' }).toArray();
  const now = new Date();
  const ruleDescription = ['bulk import', String(opts.source || '').trim(), usageDay(now.getTime())].filter(Boolean).join(' · ');
  const seen = new Set<string>();
  const counts: ImportCounts = { total: roster.length, created: 0, existing: 0, invalid: 0, notAllowed: 0, duplicate: 0, rulesCreated: 0, logtoFailed: 0 };
  const problems: { email: string; reason: string }[] = [];

  for (const { email, name } of roster) {
    if (!validEmail(email)) { counts.invalid++; problems.push({ email, reason: 'invalid' }); continue; }
    if (seen.has(email)) { counts.duplicate++; problems.push({ email, reason: 'duplicate' }); continue; }
    seen.add(email);
    if (await col.users.findOne({ email })) { counts.existing++; problems.push({ email, reason: 'exists' }); continue; }

    if (!matchEmail(activeRules, email)) {
      if (!autoRule) { counts.notAllowed++; problems.push({ email, reason: 'notAllowed' }); continue; }
      const rule: EmailAllowRule = { type: 'exact', pattern: email, status: 'active', description: ruleDescription, created_by: actorId, created_at: now };
      await col.emailRules.insertOne(rule);
      activeRules.push(rule);
      counts.rulesCreated++;
    }

    let logtoId: string | null = null;
    let logtoFailed = false;
    const prov = getIdentityProvider()?.provisioning;
    if (prov) {
      try {
        const created = await prov.createUser({ email, name: name || undefined });
        logtoId = created.id;
      } catch (err) {
        console.error('idp provision failed (import)', email, err);
        logtoFailed = true;
      }
    }
    await col.users.insertOne({
      email, name, department: '', status: 'active', source: 'import',
      roles: role ? [role] : [], app_overrides: [], logto_user_id: logtoId,
      created_by: actorId, created_at: now, updated_at: now, last_login_at: null,
      last_synced_to_logto_at: logtoId ? now : null,
    } as User);
    counts.created++;
    if (logtoFailed) { counts.logtoFailed++; problems.push({ email, reason: 'logtoFailed' }); }
  }

  await audit({ actor_user_id: actorId, action: 'user.import', target_type: 'user', after: { ...counts, role: role || null, autoRule } });
  return { counts, problems, role: role || null };
}
