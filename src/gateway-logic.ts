import { PublicPath } from './types';

// Normalize a path: strip query, decode, collapse //, resolve . and .. , drop a
// trailing slash. Run BEFORE app-key extraction and public-path matching, or
// encoded traversal (/apps/x/..%2f..%2fadmin) could dodge the rules.
export function normalizePath(raw: string): string {
  let p = (raw || '/').split('?')[0] || '/';
  // Decode repeatedly so %252e-style double-encoding can't smuggle separators.
  for (let i = 0; i < 3; i++) {
    if (!/%[0-9a-fA-F]{2}/.test(p)) break;
    try {
      const dec = decodeURIComponent(p);
      if (dec === p) break;
      p = dec;
    } catch {
      break;
    }
  }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  const joined = '/' + out.join('/');
  return joined === '/' ? '/' : joined.replace(/\/$/, '');
}

// Extract the app key and the app-relative path from a normalized portal path.
export function parseAppPath(normalized: string): { appKey: string; relPath: string } | null {
  const m = normalized.match(/^\/apps\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  return { appKey: m[1], relPath: normalizePath(m[2] || '/') };
}

// Public-path globs are admin-configured and low-cardinality, but matchesPublic
// runs on every verify — so compile each pattern once and memoize the RegExp
// rather than rebuilding it per request.
const regexCache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  regexCache.set(pattern, compiled);
  return compiled;
}

export function matchesPublic(paths: PublicPath[], method: string, relPath: string): boolean {
  for (const p of paths || []) {
    if (p.method !== '*' && p.method.toUpperCase() !== method.toUpperCase()) continue;
    if (globToRegExp(p.pattern).test(relPath)) return true;
  }
  return false;
}

// Browser navigation vs API/XHR. Prefer the unspoofable Sec-Fetch-Mode; fall
// back to Accept. Ambiguous → false (API-style), since a stray 302 corrupts an
// API client while a stray 401 is recoverable.
export function isNavigation(secFetchMode?: string, accept?: string): boolean {
  if (secFetchMode) return secFetchMode === 'navigate';
  return (accept || '').includes('text/html');
}
