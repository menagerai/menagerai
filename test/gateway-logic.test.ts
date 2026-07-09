import { describe, expect, it } from 'vitest';
import { globToRegExp, isNavigation, matchesPublic, normalizePath, parseAppPath } from '../src/gateway-logic';
import { PublicPath } from '../src/types';

describe('normalizePath — traversal & encoding defense', () => {
  it('passes through a clean path', () => {
    expect(normalizePath('/apps/demo/api/tree')).toBe('/apps/demo/api/tree');
  });
  it('drops a trailing slash but keeps root', () => {
    expect(normalizePath('/apps/demo/')).toBe('/apps/demo');
    expect(normalizePath('/')).toBe('/');
  });
  it('strips the query string', () => {
    expect(normalizePath('/apps/demo/api/tree?x=1')).toBe('/apps/demo/api/tree');
  });
  it('collapses duplicate slashes', () => {
    expect(normalizePath('/apps//demo///api')).toBe('/apps/demo/api');
  });
  it('resolves encoded .. so it cannot ride the public prefix into a protected path', () => {
    // /api/public/../../admin -> the two .. pop `public` and `api`, landing on
    // the PROTECTED /apps/demo/admin (not the public /api/public/** allowlist).
    expect(normalizePath('/apps/demo/api/public/..%2f..%2fadmin')).toBe('/apps/demo/admin');
  });
  it('lets .. climb to a different app prefix when deep enough (routing, not bypass)', () => {
    expect(normalizePath('/apps/demo/..%2ffinance/secret')).toBe('/apps/finance/secret');
  });
  it('defeats double-encoded dot-dot', () => {
    expect(normalizePath('/apps/x/%252e%252e/y')).toBe('/apps/y');
  });
  it('normalizes backslashes to forward slashes', () => {
    expect(normalizePath('/apps\\demo\\api')).toBe('/apps/demo/api');
  });
});

describe('parseAppPath', () => {
  it('extracts key and relative path', () => {
    expect(parseAppPath('/apps/demo/api/tree')).toEqual({ appKey: 'demo', relPath: '/api/tree' });
  });
  it('uses / as the relative path at the app root', () => {
    expect(parseAppPath('/apps/demo')).toEqual({ appKey: 'demo', relPath: '/' });
  });
  it('returns null for non-app paths', () => {
    expect(parseAppPath('/')).toBeNull();
    expect(parseAppPath('/login')).toBeNull();
    expect(parseAppPath('/apps')).toBeNull();
  });
});

describe('matchesPublic — glob & method scoping', () => {
  const paths: PublicPath[] = [
    { method: 'GET', pattern: '/healthz' },
    { method: 'GET', pattern: '/api/public' },
    { method: 'GET', pattern: '/api/public/**' },
    { method: 'POST', pattern: '/api/webhooks/*' },
  ];

  it('matches exact and subtree public reads', () => {
    expect(matchesPublic(paths, 'GET', '/api/public')).toBe(true);
    expect(matchesPublic(paths, 'GET', '/api/public/a/b/c')).toBe(true);
    expect(matchesPublic(paths, 'GET', '/healthz')).toBe(true);
  });
  it('is method-scoped', () => {
    expect(matchesPublic(paths, 'POST', '/healthz')).toBe(false);
    expect(matchesPublic(paths, 'GET', '/api/webhooks/x')).toBe(false);
    expect(matchesPublic(paths, 'POST', '/api/webhooks/x')).toBe(true);
  });
  it('does not let a protected path slip through', () => {
    expect(matchesPublic(paths, 'GET', '/api/tree')).toBe(false);
    expect(matchesPublic(paths, 'PUT', '/api/tree')).toBe(false);
  });
  it('* matches one segment, ** matches across segments', () => {
    expect(globToRegExp('/x/*').test('/x/a')).toBe(true);
    expect(globToRegExp('/x/*').test('/x/a/b')).toBe(false);
    expect(globToRegExp('/x/**').test('/x/a/b')).toBe(true);
  });
});

describe('isNavigation — browser vs API', () => {
  it('trusts Sec-Fetch-Mode first', () => {
    expect(isNavigation('navigate', 'application/json')).toBe(true);
    expect(isNavigation('cors', 'text/html')).toBe(false);
  });
  it('falls back to Accept', () => {
    expect(isNavigation(undefined, 'text/html,application/xhtml+xml')).toBe(true);
    expect(isNavigation(undefined, 'application/json')).toBe(false);
  });
  it('treats ambiguous as API-style', () => {
    expect(isNavigation(undefined, undefined)).toBe(false);
  });
});
