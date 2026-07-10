import { describe, expect, it } from 'vitest';
import { describeUserAgent, extractHost, formatInstant, originFor, parseHostList, safeReturnTo, syncedNameFromClaims } from '../src/util';
import { sessionExpired } from '../src/sessions';

describe('formatInstant — display stored UTC instants in a target timezone', () => {
  const utc = '2026-06-24T00:30:45Z'; // 08:30:45 in Asia/Shanghai (UTC+8)
  it('converts UTC to the given IANA zone (minute precision by default)', () => {
    expect(formatInstant(utc, 'Asia/Shanghai')).toBe('2026-06-24 08:30');
    expect(formatInstant(new Date(utc), 'UTC')).toBe('2026-06-24 00:30');
  });
  it('includes seconds when asked', () => {
    expect(formatInstant(utc, 'Asia/Shanghai', { seconds: true })).toBe('2026-06-24 08:30:45');
  });
  it('rolls the date across the zone boundary', () => {
    // 20:00 UTC is already the next day in Shanghai
    expect(formatInstant('2026-06-23T20:00:00Z', 'Asia/Shanghai')).toBe('2026-06-24 04:00');
  });
  it('renders midnight as 00, not 24', () => {
    expect(formatInstant('2026-06-23T16:00:00Z', 'Asia/Shanghai')).toBe('2026-06-24 00:00');
  });
  it('shows an em dash for missing or invalid values', () => {
    expect(formatInstant(null, 'UTC')).toBe('—');
    expect(formatInstant(undefined, 'UTC')).toBe('—');
    expect(formatInstant('', 'UTC')).toBe('—');
    expect(formatInstant('not a date', 'UTC')).toBe('—');
  });
});

describe('extractHost / parseHostList — derive allowlist from deployment domains', () => {
  it('extracts a bare host from a URL, host:port, or host', () => {
    expect(extractHost('https://intra.example.com/path')).toBe('intra.example.com');
    expect(extractHost('app.example.com:443')).toBe('app.example.com');
    expect(extractHost('PORTAL.example.com')).toBe('portal.example.com');
    expect(extractHost('')).toBeNull();
  });
  it('merges & dedupes comma lists from multiple sources (e.g. COOLIFY_FQDN)', () => {
    const hosts = parseHostList(
      'https://portal.example.com',
      'app.example.com,intra.example.com',
      'https://portal.example.com,https://extra.example.com', // a Coolify-style value
      undefined,
    );
    expect(hosts).toEqual(['portal.example.com', 'app.example.com', 'intra.example.com', 'extra.example.com']);
  });
});

describe('originFor — host allowlist (host-injection defense)', () => {
  const allowed = ['portal.example.com', 'app.example.com', 'intra.example.com'];
  const fallback = 'https://portal.example.com';

  it('uses an allowlisted forwarded host with its proto', () => {
    expect(originFor({ forwardedHost: 'intra.example.com', forwardedProto: 'https' }, allowed, fallback)).toBe(
      'https://intra.example.com',
    );
  });
  it('strips a port and lowercases the host', () => {
    expect(originFor({ forwardedHost: 'APP.example.com:443', forwardedProto: 'https' }, allowed, fallback)).toBe(
      'https://app.example.com',
    );
  });
  it('falls back for an unknown (injected) host', () => {
    expect(originFor({ forwardedHost: 'evil.com', forwardedProto: 'https' }, allowed, fallback)).toBe(fallback);
  });
  it('falls back when no host is present', () => {
    expect(originFor({}, allowed, fallback)).toBe(fallback);
  });
  it('takes the first host from a comma list and defaults proto to https', () => {
    expect(originFor({ forwardedHost: 'intra.example.com, evil.com' }, allowed, fallback)).toBe(
      'https://intra.example.com',
    );
  });
  it('honors the Host header when no forwarded host is set', () => {
    expect(originFor({ host: 'portal.example.com', forwardedProto: 'http' }, allowed, fallback)).toBe('http://portal.example.com');
  });
});

describe('safeReturnTo — open-redirect defense', () => {
  it('keeps same-host relative paths', () => {
    expect(safeReturnTo('/apps/demo')).toBe('/apps/demo');
    expect(safeReturnTo('/')).toBe('/');
  });
  it('rejects protocol-relative and absolute URLs', () => {
    expect(safeReturnTo('//evil.com')).toBe('/');
    expect(safeReturnTo('https://evil.com')).toBe('/');
    expect(safeReturnTo('http://evil.com/x')).toBe('/');
  });
  it('rejects backslash tricks and non-strings', () => {
    expect(safeReturnTo('/\\evil.com')).toBe('/');
    expect(safeReturnTo('relative')).toBe('/');
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo(123 as unknown)).toBe('/');
  });
});

describe('syncedNameFromClaims — Logto → portal name pull', () => {
  it('returns a new, different, non-empty name', () => {
    expect(syncedNameFromClaims('Old', 'New')).toBe('New');
    expect(syncedNameFromClaims(undefined, 'Alice')).toBe('Alice');
    expect(syncedNameFromClaims('Alice', '  Bob  ')).toBe('Bob'); // trimmed
  });
  it('returns undefined when unchanged, empty, or not a string', () => {
    expect(syncedNameFromClaims('Alice', 'Alice')).toBeUndefined();
    expect(syncedNameFromClaims('Alice', '   ')).toBeUndefined();
    expect(syncedNameFromClaims('', '')).toBeUndefined();
    expect(syncedNameFromClaims('Alice', undefined)).toBeUndefined();
    expect(syncedNameFromClaims('Alice', 42)).toBeUndefined();
  });
});

describe('describeUserAgent — best-effort browser/OS for the session list', () => {
  it('parses common desktop browser + OS combos', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')).toBe('Chrome on Windows');
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15')).toBe('Safari on macOS');
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0')).toBe('Firefox on Linux');
  });
  it('distinguishes Edge from Chrome (Edg/ token wins)', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0')).toBe('Edge on Windows');
  });
  it('parses mobile user agents', () => {
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36')).toBe('Chrome on Android');
  });
  it('falls back gracefully for empty, undefined, or unrecognized UAs', () => {
    expect(describeUserAgent(undefined)).toBe('Unknown device');
    expect(describeUserAgent(null)).toBe('Unknown device');
    expect(describeUserAgent('')).toBe('Unknown device');
    expect(describeUserAgent('   ')).toBe('Unknown device');
    expect(describeUserAgent('curl/8.4.0')).toBe('Unknown device');
  });
});

describe('sessionExpired — idle and absolute caps', () => {
  const now = 1_000_000;
  it('is valid when both expiries are in the future', () => {
    expect(sessionExpired({ expires_at: new Date(now + 1000), absolute_expiry: new Date(now + 5000) }, now)).toBe(false);
  });
  it('expires when idle has passed', () => {
    expect(sessionExpired({ expires_at: new Date(now - 1), absolute_expiry: new Date(now + 5000) }, now)).toBe(true);
  });
  it('expires when the absolute cap has passed even if idle is fresh', () => {
    expect(sessionExpired({ expires_at: new Date(now + 5000), absolute_expiry: new Date(now - 1) }, now)).toBe(true);
  });
  it('treats the exact boundary as expired', () => {
    expect(sessionExpired({ expires_at: new Date(now), absolute_expiry: new Date(now + 5000) }, now)).toBe(true);
  });
});
