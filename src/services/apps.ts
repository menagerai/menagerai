import { col } from '../db';
import { audit } from '../audit';
import { config } from '../config';
import { evictAll } from '../decide';
import { parseJson, validatePublicPaths, validKey } from '../admin-logic';
import { AppDoc, AppStatus } from '../types';
import { ApiError, NotFoundError } from './errors';
import { genSecret } from './common';

export function listApps(): Promise<AppDoc[]> {
  return col.apps.find().sort({ name: 1 }).toArray();
}

export async function getApp(key: string): Promise<AppDoc> {
  const app = await col.apps.findOne({ key });
  if (!app) throw new NotFoundError();
  return app;
}

export async function createApp(
  input: { key: string; name?: string; description?: string },
  actorId: string,
): Promise<{ key: string }> {
  const key = String(input.key || '').trim();
  if (!validKey(key)) throw new ApiError(400, 'flash.invalidAppKey');
  if (await col.apps.findOne({ key })) throw new ApiError(409, 'flash.appExists');
  const now = new Date();
  await col.apps.insertOne({
    key,
    name: String(input.name || '').trim() || key,
    base_path: `/apps/${key}`,
    auth_mode: 'proxy',
    status: 'active',
    description: String(input.description || ''),
    public_paths: [],
    proxy_secret: genSecret(),
    created_at: now,
    updated_at: now,
  });
  await audit({ actor_user_id: actorId, action: 'app.create', target_type: 'app', target_id: key });
  return { key };
}

// public_paths arrives as a JSON string from the UI textarea; the API may pass an
// array directly. Accept either.
export async function updateApp(
  key: string,
  input: { name?: string; description?: string; status?: string; public_paths?: unknown; default_base_url?: string },
  actorId: string,
): Promise<void> {
  const app = await col.apps.findOne({ key });
  if (!app) throw new NotFoundError();
  let parsedPaths: unknown = input.public_paths ?? [];
  if (typeof parsedPaths === 'string') {
    const p = parseJson(parsedPaths || '[]');
    if (!p.ok) throw new ApiError(400, p.error);
    parsedPaths = p.value;
  }
  const pathsV = validatePublicPaths(parsedPaths);
  if (!pathsV.ok) throw new ApiError(400, pathsV.error, pathsV.vars);

  const status: AppStatus = ['active', 'disabled', 'planned'].includes(String(input.status))
    ? (input.status as AppStatus)
    : app.status;
  // '' means unset (link stays portal-relative); anything else must be one of
  // the operator-configured DEFAULT_BASE_URLS.
  const defaultBaseUrl = String(input.default_base_url || '').trim();
  if (defaultBaseUrl && !config.defaultBaseUrls.includes(defaultBaseUrl)) {
    throw new ApiError(400, 'flash.invalidDefaultBaseUrl');
  }
  const update: Partial<AppDoc> = {
    name: String(input.name || app.name),
    description: String(input.description || ''),
    status,
    public_paths: pathsV.value,
    default_base_url: defaultBaseUrl,
    updated_at: new Date(),
  };
  await col.apps.updateOne({ key: app.key }, { $set: update });
  evictAll();
  await audit({ actor_user_id: actorId, action: 'app.update', target_type: 'app', target_id: app.key, before: { public_paths: app.public_paths, status: app.status }, after: update });
}

export async function renameApp(key: string, newKeyInput: string, actorId: string): Promise<{ key: string; rolesUpdated: number; usersUpdated: number }> {
  const app = await col.apps.findOne({ key });
  if (!app) throw new NotFoundError();
  const newKey = String(newKeyInput || '').trim();
  if (!validKey(newKey)) throw new ApiError(400, 'flash.invalidAppKey');
  if (newKey === app.key) throw new ApiError(400, 'flash.keyUnchanged');
  if (await col.apps.findOne({ key: newKey })) throw new ApiError(409, 'flash.appKeyExists');
  const now = new Date();
  await col.apps.updateOne({ key: app.key }, { $set: { key: newKey, base_path: `/apps/${newKey}`, updated_at: now } });
  // Cascade every reference to the old key.
  const [roleRes, userRes] = await Promise.all([
    col.roles.updateMany({ 'grants.app': app.key }, { $set: { 'grants.$[g].app': newKey, updated_at: now } }, { arrayFilters: [{ 'g.app': app.key }] }),
    col.users.updateMany({ 'app_overrides.app': app.key }, { $set: { 'app_overrides.$[o].app': newKey, updated_at: now } }, { arrayFilters: [{ 'o.app': app.key }] }),
  ]);
  await col.usageDaily.updateMany({ app_key: app.key }, { $set: { app_key: newKey } });
  evictAll();
  await audit({ actor_user_id: actorId, action: 'app.rename', target_type: 'app', target_id: newKey, before: { key: app.key }, after: { key: newKey, roles_updated: roleRes.modifiedCount, users_updated: userRes.modifiedCount } });
  return { key: newKey, rolesUpdated: roleRes.modifiedCount, usersUpdated: userRes.modifiedCount };
}

export async function deleteApp(key: string, actorId: string): Promise<{ rolesCleaned: number; usersCleaned: number }> {
  const app = await col.apps.findOne({ key });
  if (!app) throw new NotFoundError();
  const [roleRes, userRes] = await Promise.all([
    col.roles.updateMany({ 'grants.app': app.key }, { $pull: { grants: { app: app.key } }, $set: { updated_at: new Date() } }),
    col.users.updateMany({ 'app_overrides.app': app.key }, { $pull: { app_overrides: { app: app.key } }, $set: { updated_at: new Date() } }),
  ]);
  await col.apps.deleteOne({ key: app.key });
  await col.usageDaily.deleteMany({ app_key: app.key });
  evictAll();
  await audit({ actor_user_id: actorId, action: 'app.delete', target_type: 'app', target_id: app.key, before: { name: app.name, status: app.status }, after: { roles_cleaned: roleRes.modifiedCount, users_cleaned: userRes.modifiedCount } });
  return { rolesCleaned: roleRes.modifiedCount, usersCleaned: userRes.modifiedCount };
}

export async function regenerateSecret(key: string, actorId: string): Promise<{ proxy_secret: string }> {
  const app = await col.apps.findOne({ key });
  if (!app) throw new NotFoundError();
  const secret = genSecret();
  await col.apps.updateOne({ key: app.key }, { $set: { proxy_secret: secret, updated_at: new Date() } });
  await audit({ actor_user_id: actorId, action: 'app.regenerate_secret', target_type: 'app', target_id: app.key });
  return { proxy_secret: secret };
}
