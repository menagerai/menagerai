import { col } from '../db';
import { audit } from '../audit';
import { evictAll } from '../decide';
import { validKey } from '../admin-logic';
import { Role } from '../types';
import { ApiError, NotFoundError } from './errors';
import { PROTECTED_ROLE } from './common';

export function listRoles(): Promise<Role[]> {
  return col.roles.find().sort({ key: 1 }).toArray();
}

export async function getRole(key: string): Promise<Role> {
  const role = await col.roles.findOne({ key });
  if (!role) throw new NotFoundError();
  return role;
}

export async function createRole(
  input: { key: string; name?: string; description?: string },
  actorId: string,
): Promise<{ key: string }> {
  const key = String(input.key || '').trim();
  const name = String(input.name || '').trim() || key;
  if (!validKey(key)) throw new ApiError(400, 'flash.invalidRoleKey');
  if (await col.roles.findOne({ key })) throw new ApiError(409, 'flash.roleExists');
  const now = new Date();
  await col.roles.insertOne({ key, name, description: String(input.description || ''), grants: [], created_at: now, updated_at: now });
  await audit({ actor_user_id: actorId, action: 'role.create', target_type: 'role', target_id: key });
  return { key };
}

export async function editRole(
  key: string,
  input: { name?: string; description?: string },
  actorId: string,
): Promise<void> {
  const role = await col.roles.findOne({ key });
  if (!role) throw new NotFoundError();
  const name = String(input.name || '').trim() || role.key;
  const description = String(input.description || '').trim();
  await col.roles.updateOne({ key: role.key }, { $set: { name, description, updated_at: new Date() } });
  await audit({ actor_user_id: actorId, action: 'role.edit', target_type: 'role', target_id: role.key, before: { name: role.name, description: role.description }, after: { name, description } });
}

export async function renameRole(key: string, newKeyInput: string, actorId: string): Promise<{ key: string; usersUpdated: number }> {
  const role = await col.roles.findOne({ key });
  if (!role) throw new NotFoundError();
  if (role.key === PROTECTED_ROLE) throw new ApiError(403, 'flash.roleKeyStructural', { role: PROTECTED_ROLE });
  const newKey = String(newKeyInput || '').trim();
  if (!validKey(newKey)) throw new ApiError(400, 'flash.invalidRoleKey');
  if (newKey === role.key) throw new ApiError(400, 'flash.keyUnchanged');
  if (await col.roles.findOne({ key: newKey })) throw new ApiError(409, 'flash.roleKeyExists');
  const now = new Date();
  await col.roles.updateOne({ key: role.key }, { $set: { key: newKey, updated_at: now } });
  // Cascade: rewrite the key wherever a user references it (one slot per user).
  const affected = await col.users.updateMany({ roles: role.key }, { $set: { 'roles.$': newKey, updated_at: now } });
  evictAll();
  await audit({ actor_user_id: actorId, action: 'role.rename', target_type: 'role', target_id: newKey, before: { key: role.key }, after: { key: newKey, users_updated: affected.modifiedCount } });
  return { key: newKey, usersUpdated: affected.modifiedCount };
}

export async function addGrant(key: string, app: string, actorId: string): Promise<void> {
  const role = await col.roles.findOne({ key });
  if (!role) throw new NotFoundError();
  const appKey = String(app || '');
  if (!(await col.apps.findOne({ key: appKey }))) throw new ApiError(400, 'flash.unknownApp');
  // Binary grant: holding this role grants access to the app. One row per app.
  await col.roles.updateOne({ key: role.key }, { $pull: { grants: { app: appKey } } });
  await col.roles.updateOne({ key: role.key }, { $push: { grants: { app: appKey } }, $set: { updated_at: new Date() } });
  evictAll();
  await audit({ actor_user_id: actorId, action: 'role.grant', target_type: 'role', target_id: role.key, after: { app: appKey } });
}

export async function deleteGrant(key: string, app: string, actorId: string): Promise<void> {
  const role = await col.roles.findOne({ key });
  if (!role) throw new NotFoundError();
  const appKey = String(app || '');
  await col.roles.updateOne({ key: role.key }, { $pull: { grants: { app: appKey } }, $set: { updated_at: new Date() } });
  evictAll();
  await audit({ actor_user_id: actorId, action: 'role.grant.delete', target_type: 'role', target_id: role.key, after: { app: appKey } });
}

export async function deleteRole(key: string, actorId: string): Promise<{ usersUnassigned: number }> {
  const role = await col.roles.findOne({ key });
  if (!role) throw new NotFoundError();
  if (role.key === PROTECTED_ROLE) throw new ApiError(403, 'flash.roleNoDelete', { role: PROTECTED_ROLE });
  // Referential integrity: strip this role key from every user that holds it.
  const affected = await col.users.updateMany({ roles: role.key }, { $pull: { roles: role.key }, $set: { updated_at: new Date() } });
  await col.roles.deleteOne({ key: role.key });
  evictAll();
  await audit({ actor_user_id: actorId, action: 'role.delete', target_type: 'role', target_id: role.key, before: { name: role.name, grants: role.grants }, after: { users_unassigned: affected.modifiedCount } });
  return { usersUnassigned: affected.modifiedCount };
}
