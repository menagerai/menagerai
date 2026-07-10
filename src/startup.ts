import { Issuer } from 'openid-client';

// Startup configuration preflight. Menagerai delegates authentication to Logto, so
// a handful of env vars MUST be set and the Logto endpoints MUST actually answer
// before the app can do anything useful. Rather than crash the container (which
// hides the reason from anyone not tailing logs) we always boot, run these checks,
// and — when they fail — serve a plain-language config screen (see app.ts) listing
// exactly what is unset or unreachable. Superadmin seeding and every other init
// step is gated on ok === true (see server-all.ts / server-web.ts), so a
// misconfigured instance never writes half-baked bootstrap state.

export type ProblemSeverity = 'missing' | 'invalid' | 'unreachable';

export interface StartupProblem {
  key: string;
  severity: ProblemSeverity;
  message: string;
}

export interface StartupCheck {
  ok: boolean;
  problems: StartupProblem[];
  checkedAt: Date;
}

// Every var that must be present for a working install. Logto is the one wired
// provider today; when a second OIDC+Management-API provider is verified as a
// drop-in, this list becomes provider-selected.
const REQUIRED_VARS = [
  'PORTAL_BASE_URL',
  'SUPERADMIN_EMAIL',
  'LOGTO_ENDPOINT',
  'LOGTO_APP_ID',
  'LOGTO_APP_SECRET',
  'LOGTO_M2M_APP_ID',
  'LOGTO_M2M_APP_SECRET',
  'LOGTO_MANAGEMENT_API_RESOURCE',
] as const;

function val(key: string): string {
  return (process.env[key] ?? '').trim();
}

export async function runStartupChecks(): Promise<StartupCheck> {
  const problems: StartupProblem[] = [];

  // 1. Presence — the cheap, deterministic checks first.
  for (const key of REQUIRED_VARS) {
    if (!val(key)) problems.push({ key, severity: 'missing', message: `${key} is not set.` });
  }

  // 2. Format — only when present, so we don't double-report a missing var.
  if (val('SUPERADMIN_EMAIL') && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val('SUPERADMIN_EMAIL'))) {
    problems.push({ key: 'SUPERADMIN_EMAIL', severity: 'invalid', message: 'SUPERADMIN_EMAIL is not a valid email address.' });
  }
  if (val('PORTAL_BASE_URL')) {
    try {
      new URL(val('PORTAL_BASE_URL'));
    } catch {
      problems.push({ key: 'PORTAL_BASE_URL', severity: 'invalid', message: 'PORTAL_BASE_URL must be a full URL, e.g. https://portal.example.com.' });
    }
  }

  const endpoint = val('LOGTO_ENDPOINT').replace(/\/+$/, '');

  // 3. Live checks — only attempt when the inputs they need are present, so a
  //    missing var produces one clear "missing" line rather than a noisy failure.
  if (endpoint) {
    try {
      await Issuer.discover(`${endpoint}/oidc`);
    } catch {
      problems.push({
        key: 'LOGTO_ENDPOINT',
        severity: 'unreachable',
        message: `Could not reach the Logto OIDC issuer at ${endpoint}/oidc — check LOGTO_ENDPOINT and that Logto is running.`,
      });
    }
  }

  const haveM2m = endpoint && val('LOGTO_M2M_APP_ID') && val('LOGTO_M2M_APP_SECRET') && val('LOGTO_MANAGEMENT_API_RESOURCE');
  if (haveM2m) {
    try {
      const basic = Buffer.from(`${val('LOGTO_M2M_APP_ID')}:${val('LOGTO_M2M_APP_SECRET')}`).toString('base64');
      const body = new URLSearchParams({ grant_type: 'client_credentials', resource: val('LOGTO_MANAGEMENT_API_RESOURCE'), scope: 'all' });
      const tokRes = await fetch(`${endpoint}/oidc/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
        body,
      });
      if (!tokRes.ok) {
        problems.push({
          key: 'LOGTO_M2M_APP_SECRET',
          severity: 'unreachable',
          message: `Logto rejected the Management API (M2M) credentials (${tokRes.status}). Check LOGTO_M2M_APP_ID, LOGTO_M2M_APP_SECRET and LOGTO_MANAGEMENT_API_RESOURCE.`,
        });
      } else {
        // The token can be minted but still lack the role that actually grants
        // Management API access, so confirm with one authenticated read.
        const token = ((await tokRes.json()) as { access_token?: string }).access_token || '';
        const probe = await fetch(`${endpoint}/api/users?page=1&page_size=1`, { headers: { Authorization: `Bearer ${token}` } });
        if (!probe.ok) {
          problems.push({
            key: 'LOGTO_MANAGEMENT_API_RESOURCE',
            severity: 'unreachable',
            message: `The M2M app authenticated but the Management API returned ${probe.status}. Grant the M2M app the "Logto Management API access" role.`,
          });
        }
      }
    } catch (err) {
      problems.push({
        key: 'LOGTO_MANAGEMENT_API_RESOURCE',
        severity: 'unreachable',
        message: `Could not reach the Logto Management API at ${endpoint}/api — ${(err as Error).message}.`,
      });
    }
  }

  return { ok: problems.length === 0, problems, checkedAt: new Date() };
}

// One-line-per-problem summary for the container logs (complements the browser
// screen for operators who do watch logs).
export function logStartupProblems(check: StartupCheck): void {
  if (check.ok) return;
  console.error(`Startup configuration incomplete — ${check.problems.length} issue(s); the app is serving a configuration screen instead of the portal:`);
  for (const p of check.problems) console.error(`  [${p.severity}] ${p.key}: ${p.message}`);
}
