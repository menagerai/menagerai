import { PublicPath } from './types';

// On failure, `error` is an i18n key (see locales `validate.*`) and `vars`
// carries any interpolation values, so the message can be shown in the viewer's
// locale rather than as a hardcoded English string.
export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; vars?: Record<string, string | number> };

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const METHODS = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// App and role keys: url-safe, lowercase, immutable. An app key is also a URL
// path segment, so it must be tightly constrained: start alphanumeric, then
// lowercase letters, digits, hyphens or underscores (e.g. sales).
export function validKey(k: unknown): boolean {
  return typeof k === 'string' && KEY_RE.test(k);
}

export function validEmail(e: unknown): boolean {
  return typeof e === 'string' && EMAIL_RE.test(e.trim());
}

export function validatePublicPaths(input: unknown): Validation<PublicPath[]> {
  if (!Array.isArray(input)) return { ok: false, error: 'validate.publicPathsNotArray' };
  const out: PublicPath[] = [];
  for (const p of input as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'validate.pathNotObject' };
    const method = String(p.method || '*').toUpperCase();
    if (!METHODS.includes(method)) return { ok: false, error: 'validate.invalidMethod', vars: { method } };
    const pattern = String(p.pattern || '');
    if (!pattern.startsWith('/')) return { ok: false, error: 'validate.patternNoSlash', vars: { pattern } };
    out.push({ method: method === '*' ? '*' : method, pattern });
  }
  return { ok: true, value: out };
}

// A per-user override is just an effect: access is binary, so there is no role
// to name. allow = one-off grant; deny = per-user kill switch.
export function validateOverride(effect: unknown): Validation<{ effect: 'allow' | 'deny' }> {
  if (effect !== 'allow' && effect !== 'deny') return { ok: false, error: 'validate.invalidEffect' };
  return { ok: true, value: { effect } };
}

// Parse JSON from a textarea, returning a typed error rather than throwing.
// `error` is an i18n key like every other validator here (see locales `validate.*`).
export function parseJson<T = unknown>(raw: string): Validation<T> {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, error: 'validate.invalidJson' };
  }
}

// Normalize parsed CSV rows (a 2-D array of cells) into a roster of { email, name }: column 0 = email, column 1
// = name. A leading header row (e.g. "Email","Name") is dropped by detecting that
// its first cell is not a valid email. Blank rows and rows with an empty first cell
// are skipped. Emails are trimmed + lowercased; names trimmed. Pure — invalid
// emails are NOT filtered here (the caller reports them per row), only structurally
// empty rows are dropped.
export function parseRoster(rows: unknown[][]): { email: string; name: string }[] {
  const out: { email: string; name: string }[] = [];
  let start = 0;
  // Drop a header row: if the very first non-empty row's first cell isn't an email,
  // treat it as a header label ("Email" / "邮箱" / …) and skip it.
  for (let i = 0; i < rows.length; i++) {
    const first = rows[i] && rows[i][0];
    if (first === undefined || first === null || String(first).trim() === '') continue;
    if (!validEmail(String(first))) start = i + 1;
    break;
  }
  for (let i = start; i < rows.length; i++) {
    const row = rows[i] || [];
    const email = String(row[0] ?? '').trim().toLowerCase();
    if (!email) continue; // skip blank rows
    const name = String(row[1] ?? '').trim();
    out.push({ email, name });
  }
  return out;
}

// Decode uploaded CSV bytes before cell parsing. Excel and similar tools commonly
// emit BOM-tagged UTF-8 or UTF-16 CSV files; decoding them as unconditional UTF-8
// turns UTF-16 into NUL-filled mojibake and invalidates otherwise valid rows.
export function decodeCsvBuffer(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le', 2);
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      le[i - 2] = buf[i + 1];
      le[i - 1] = buf[i];
    }
    return le.toString('utf16le');
  }
  return buf.toString('utf8');
}

// Minimal RFC 4180-style CSV reader for roster imports. Supports quoted fields,
// doubled quotes, CRLF/LF line endings, and preserves the same 2-D cell shape that
// parseRoster already consumes.
export function parseCsvRows(text: string): unknown[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((v) => v !== '') || rows.length === 0) rows.push(row);
  return rows;
}
