// Render a stored UTC instant for DISPLAY in the given IANA timezone. All DB
// records stay UTC; this only changes what the UI shows. Produces
// 'YYYY-MM-DD HH:MM' (pass { seconds: true } for 'HH:MM:SS'); a missing or
// invalid value renders as '—'. hourCycle 'h23' keeps midnight as 00, not 24.
export function formatInstant(
  value: Date | string | number | null | undefined,
  timeZone: string,
  opts: { seconds?: boolean } = {},
): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' } : {}),
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const time = `${get('hour')}:${get('minute')}${opts.seconds ? `:${get('second')}` : ''}`;
  return `${get('year')}-${get('month')}-${get('day')} ${time}`;
}

// Best-effort, dependency-free User-Agent → "<Browser> on <OS>" for the session
// list. UA strings are unreliable and spoofable, so this is for display only:
// match the common browsers/OSes, fall back gracefully, and never throw. Order
// matters — Edge/Chrome both contain "Chrome", iOS Safari contains "Safari", etc.
export function describeUserAgent(ua?: string | null): string {
  const s = (ua || '').trim();
  if (!s) return 'Unknown device';

  let browser = '';
  if (/\bEdg(?:e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/\bOPR\/|\bOpera\b/.test(s)) browser = 'Opera';
  else if (/\bSamsungBrowser\//.test(s)) browser = 'Samsung Internet';
  else if (/\bFirefox\/|\bFxiOS\//.test(s)) browser = 'Firefox';
  else if (/\bChrome\/|\bCriOS\//.test(s)) browser = 'Chrome';
  else if (/\bSafari\//.test(s) && /\bVersion\//.test(s)) browser = 'Safari';

  let os = '';
  if (/\bWindows NT\b/.test(s)) os = 'Windows';
  else if (/\biPhone\b|\biPad\b|\biPod\b|\biOS\b/.test(s)) os = 'iOS';
  else if (/\bAndroid\b/.test(s)) os = 'Android';
  else if (/\bMac OS X\b|\bMacintosh\b/.test(s)) os = 'macOS';
  else if (/\bCrOS\b/.test(s)) os = 'ChromeOS';
  else if (/\bLinux\b/.test(s)) os = 'Linux';

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return 'Unknown device';
}

// Logto → portal name sync: if the ID token carries a non-empty name that differs
// from what the portal holds, return it so login adopts it (keeps the two systems
// in sync without a webhook). Returns undefined when there is nothing to change.
export function syncedNameFromClaims(currentName: string | undefined, claimName: unknown): string | undefined {
  if (typeof claimName !== 'string') return undefined;
  const next = claimName.trim();
  if (!next || next === (currentName || '')) return undefined;
  return next;
}

// Only allow same-host relative paths as a post-login redirect target — never an
// absolute or protocol-relative URL (open-redirect defense).
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

// Extract a bare hostname from a value that may be a URL, host:port, or host.
export function extractHost(raw: string): string | null {
  let s = (raw || '').trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // strip scheme
  s = s.split('/')[0].split('?')[0]; // strip path/query
  s = s.split(':')[0]; // strip port
  s = s.trim().toLowerCase();
  return s || null;
}

// Build a deduped host allowlist from any number of comma-separated sources
// (PORTAL_BASE_URL, PORTAL_HOSTS, Coolify's COOLIFY_FQDN / COOLIFY_URL).
export function parseHostList(...values: (string | undefined)[]): string[] {
  const set = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    for (const part of v.split(',')) {
      const h = extractHost(part);
      if (h) set.add(h);
    }
  }
  return [...set];
}

// Resolve the external origin (proto://host) to use for redirects, from the
// request's forwarded host — but ONLY if that host is allowlisted. The Host
// header is attacker-controllable, so an unrecognized host falls back to the
// canonical base URL rather than being trusted (host-injection defense).
export function originFor(
  headers: { forwardedHost?: string; host?: string; forwardedProto?: string },
  allowedHosts: string[],
  fallback: string,
): string {
  const rawHost = (headers.forwardedHost || headers.host || '').split(',')[0].trim().toLowerCase();
  const host = rawHost.split(':')[0];
  if (!host || !allowedHosts.includes(host)) return fallback;
  const proto = (headers.forwardedProto || '').split(',')[0].trim() || 'https';
  return `${proto}://${host}`;
}

// Express-flavored wrapper around originFor.
export function originOf(
  req: { get(name: string): string | undefined },
  allowedHosts: string[],
  fallback: string,
): string {
  return originFor(
    { forwardedHost: req.get('x-forwarded-host'), host: req.get('host'), forwardedProto: req.get('x-forwarded-proto') },
    allowedHosts,
    fallback,
  );
}
