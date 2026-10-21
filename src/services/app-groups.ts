import { col } from '../db';
import { audit } from '../audit';
import { validKey } from '../admin-logic';
import { AppGroup } from '../types';
import { ApiError, NotFoundError } from './errors';

// App groups are display-only folders for the portal launcher. Nothing here
// touches roles, grants or overrides, and the access decision never reads a
// group — so no decision-cache eviction is needed on any of these writes.

// 'reorder' would collide with the POST /app-groups/reorder route.
const RESERVED_KEYS = new Set(['reorder']);

export function listGroups(): Promise<AppGroup[]> {
  return col.appGroups.find().sort({ position: 1, name: 1 }).toArray();
}

async function getGroup(key: string): Promise<AppGroup> {
  const group = await col.appGroups.findOne({ key });
  if (!group) throw new NotFoundError();
  return group;
}

export async function createGroup(input: { key: string; name?: string }, actorId: string): Promise<{ key: string }> {
  const key = String(input.key || '').trim();
  if (!validKey(key) || RESERVED_KEYS.has(key)) throw new ApiError(400, 'flash.invalidAppGroupKey');
  if (await col.appGroups.findOne({ key })) throw new ApiError(409, 'flash.appGroupExists');
  const name = String(input.name || '').trim() || key;
  const existing = await listGroups();
  const position = existing.length ? Math.max(...existing.map((g) => g.position)) + 1 : 0;
  const now = new Date();
  await col.appGroups.insertOne({ key, name, position, created_at: now, updated_at: now });
  await audit({ actor_user_id: actorId, action: 'app_group.create', target_type: 'app_group', target_id: key });
  return { key };
}

export async function editGroup(key: string, input: { name?: string }, actorId: string): Promise<void> {
  const group = await getGroup(key);
  const name = String(input.name || '').trim() || group.key;
  await col.appGroups.updateOne({ key: group.key }, { $set: { name, updated_at: new Date() } });
  await audit({ actor_user_id: actorId, action: 'app_group.edit', target_type: 'app_group', target_id: group.key, before: { name: group.name }, after: { name } });
}

// Persist `keys` as the new order (positions 0..n-1) and audit the change.
async function writeOrder(before: string[], keys: string[], actorId: string): Promise<void> {
  const now = new Date();
  for (let i = 0; i < keys.length; i++) {
    await col.appGroups.updateOne({ key: keys[i] }, { $set: { position: i, updated_at: now } });
  }
  await audit({ actor_user_id: actorId, action: 'app_group.reorder', target_type: 'app_group', target_id: '*', before: { keys: before }, after: { keys } });
}

export async function moveGroup(key: string, dir: 'up' | 'down', actorId: string): Promise<void> {
  if (dir !== 'up' && dir !== 'down') throw new ApiError(400, 'flash.invalidAppGroupOrder');
  await getGroup(key);
  const before = (await listGroups()).map((g) => g.key);
  const i = before.indexOf(key);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= before.length) return; // already at the edge
  const keys = before.slice();
  [keys[i], keys[j]] = [keys[j], keys[i]];
  await writeOrder(before, keys, actorId);
}

// `keys` must list every existing group exactly once.
export async function reorderGroups(keys: string[], actorId: string): Promise<void> {
  const before = (await listGroups()).map((g) => g.key);
  const valid =
    Array.isArray(keys) &&
    keys.length === before.length &&
    new Set(keys).size === keys.length &&
    keys.every((k) => before.includes(k));
  if (!valid) throw new ApiError(400, 'flash.invalidAppGroupOrder');
  await writeOrder(before, keys, actorId);
}

// Deleting a group never deletes apps: its members just become ungrouped.
export async function deleteGroup(key: string, actorId: string): Promise<{ appsUngrouped: number }> {
  const group = await getGroup(key);
  const res = await col.apps.updateMany({ group: group.key }, { $set: { group: '', updated_at: new Date() } });
  await col.appGroups.deleteOne({ key: group.key });
  await audit({ actor_user_id: actorId, action: 'app_group.delete', target_type: 'app_group', target_id: group.key, before: { name: group.name }, after: { apps_ungrouped: res.modifiedCount } });
  return { appsUngrouped: res.modifiedCount };
}
