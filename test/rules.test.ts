import { describe, expect, it } from 'vitest';
import { matchEmail } from '../src/rules';
import { EmailAllowRule } from '../src/types';

function rule(over: Partial<EmailAllowRule>): EmailAllowRule {
  return { type: 'exact', pattern: '', status: 'active', created_at: new Date(), ...over };
}

const rules: EmailAllowRule[] = [
  rule({ type: 'exact', pattern: 'admin@vendor.example' }),
  rule({ type: 'domain', pattern: 'example.com' }),
  rule({ type: 'domain', pattern: 'example.net' }),
];

describe('matchEmail — allowlist (default deny)', () => {
  it('matches the exact superadmin address (case-insensitive)', () => {
    expect(matchEmail(rules, 'admin@vendor.example')).toBe(true);
    expect(matchEmail(rules, 'ADMIN@VENDOR.EXAMPLE')).toBe(true);
  });
  it('does NOT allow other addresses at the vendor domain', () => {
    // Only the exact admin@ is allowed; vendor.example is not a domain rule.
    expect(matchEmail(rules, 'someoneelse@vendor.example')).toBe(false);
  });
  it('matches an approved corporate domain', () => {
    expect(matchEmail(rules, 'alice@example.com')).toBe(true);
    expect(matchEmail(rules, 'bob@example.net')).toBe(true);
  });
  it('does not treat a subdomain as the domain', () => {
    expect(matchEmail(rules, 'eve@evil.example.com')).toBe(false);
  });
  it('rejects an unrelated domain', () => {
    expect(matchEmail(rules, 'mallory@evil.com')).toBe(false);
  });
  it('rejects malformed and empty input', () => {
    expect(matchEmail(rules, 'not-an-email')).toBe(false);
    expect(matchEmail(rules, '')).toBe(false);
    expect(matchEmail([], 'alice@example.com')).toBe(false);
  });
  it('ignores disabled rules', () => {
    const disabled = [rule({ type: 'domain', pattern: 'example.com', status: 'disabled' })];
    expect(matchEmail(disabled, 'alice@example.com')).toBe(false);
  });
});
