import { config } from '../config';
import { StartupCheck } from '../startup';

// Demo-mode boot preflight — the DEMO_MODE replacement for runStartupChecks(). It
// is synchronous (no network: demo mode never contacts an IdP) and validates only
// what the demo actually needs: a portal base URL and a DEMO_SECRET strong enough
// to derive per-app proxy secrets from. Returns the same StartupCheck shape, so a
// failure lands on the existing "Configuration required" screen unchanged.
const MIN_SECRET_LEN = 16;

export function runDemoStartupChecks(): StartupCheck {
  const problems: StartupCheck['problems'] = [];

  const base = (process.env.PORTAL_BASE_URL ?? '').trim();
  if (!base) {
    problems.push({ key: 'PORTAL_BASE_URL', severity: 'missing', message: 'PORTAL_BASE_URL is not set.' });
  } else {
    try {
      new URL(base);
    } catch {
      problems.push({ key: 'PORTAL_BASE_URL', severity: 'invalid', message: 'PORTAL_BASE_URL must be a full URL, e.g. https://demo.example.com.' });
    }
  }

  const secret = config.demoSecret.trim();
  if (!secret) {
    problems.push({ key: 'DEMO_SECRET', severity: 'missing', message: 'DEMO_SECRET is not set (required in demo mode).' });
  } else if (secret.length < MIN_SECRET_LEN) {
    problems.push({ key: 'DEMO_SECRET', severity: 'invalid', message: `DEMO_SECRET must be at least ${MIN_SECRET_LEN} characters.` });
  }

  return { ok: problems.length === 0, problems, checkedAt: new Date() };
}
