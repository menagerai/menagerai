import { col } from '../db';
import { audit } from '../audit';
import { AuditLog, EmailAllowRule } from '../types';
import { ApiError, NotFoundError } from './errors';
import { toOid } from './common';

export function listRules(): Promise<EmailAllowRule[]> {
  return col.emailRules.find().sort({ created_at: -1 }).toArray();
}

export async function createRule(
  input: { type: unknown; pattern?: string; description?: string },
  actorId: string,
): Promise<{ id: string }> {
  const type = input.type;
  if (type !== 'exact' && type !== 'domain') throw new ApiError(400, 'flash.invalidType');
  const pattern = String(input.pattern || '').trim();
  if (!pattern) throw new ApiError(400, 'flash.patternRequired');
  const r = await col.emailRules.insertOne({ type, pattern, status: 'active', description: String(input.description || ''), created_by: actorId, created_at: new Date() });
  await audit({ actor_user_id: actorId, action: 'email_rule.create', target_type: 'email_rule', target_id: pattern });
  return { id: String(r.insertedId) };
}

export async function updateDescription(id: string, description: string, actorId: string): Promise<void> {
  const oid = toOid(id);
  const rule = await col.emailRules.findOne({ _id: oid });
  if (!rule) throw new NotFoundError();
  const desc = String(description || '').trim();
  await col.emailRules.updateOne({ _id: oid }, { $set: { description: desc } });
  await audit({ actor_user_id: actorId, action: 'email_rule.description', target_type: 'email_rule', target_id: rule.pattern, before: { description: rule.description }, after: { description: desc } });
}

export async function toggleRule(id: string, actorId: string): Promise<{ status: 'active' | 'disabled' }> {
  const oid = toOid(id);
  const rule = await col.emailRules.findOne({ _id: oid });
  if (!rule) throw new NotFoundError();
  const next = rule.status === 'active' ? 'disabled' : 'active';
  await col.emailRules.updateOne({ _id: oid }, { $set: { status: next } });
  await audit({ actor_user_id: actorId, action: 'email_rule.toggle', target_type: 'email_rule', target_id: rule.pattern, after: { status: next } });
  return { status: next };
}

export async function deleteRule(id: string, actorId: string): Promise<void> {
  const oid = toOid(id);
  const rule = await col.emailRules.findOne({ _id: oid });
  if (!rule) throw new NotFoundError();
  await col.emailRules.deleteOne({ _id: oid });
  await audit({ actor_user_id: actorId, action: 'email_rule.delete', target_type: 'email_rule', target_id: rule.pattern, before: { type: rule.type, pattern: rule.pattern, status: rule.status } });
}

export function listAudit(limit = 200): Promise<AuditLog[]> {
  return col.audit.find().sort({ created_at: -1 }).limit(limit).toArray();
}
