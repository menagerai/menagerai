import { col } from './db';
import { EmailAllowRule } from './types';

// PURE: does an email satisfy at least one active allow rule? Default deny.
export function matchEmail(rules: EmailAllowRule[], email: string): boolean {
  const e = String(email || '').trim().toLowerCase();
  if (!e.includes('@')) return false;
  const domain = e.split('@')[1] || '';
  for (const r of rules) {
    if (r.status !== 'active') continue;
    const pattern = r.pattern.trim().toLowerCase();
    if (r.type === 'exact' && e === pattern) return true;
    if (r.type === 'domain' && domain === pattern.replace(/^@/, '')) return true;
  }
  return false;
}

export async function emailAllowed(email: string): Promise<boolean> {
  const rules = await col.emailRules.find({ status: 'active' }).toArray();
  return matchEmail(rules, email);
}
