import { describe, expect, it } from 'vitest';
import {
  decodeCsvBuffer,
  parseCsvRows,
  parseJson,
  parseRoster,
  validateOverride,
  validatePublicPaths,
  validEmail,
  validKey,
} from '../src/admin-logic';

describe('validKey', () => {
  it('accepts url-safe lowercase keys', () => {
    expect(validKey('demo')).toBe(true);
    expect(validKey('purchase-approval')).toBe(true);
    expect(validKey('sales')).toBe(true); // underscores allowed
    expect(validKey('a1')).toBe(true);
  });
  it('rejects unsafe keys', () => {
    expect(validKey('Demo')).toBe(false);
    expect(validKey('has space')).toBe(false);
    expect(validKey('-leading')).toBe(false);
    expect(validKey('_leading')).toBe(false); // must start alphanumeric
    expect(validKey('with/slash')).toBe(false);
    expect(validKey('')).toBe(false);
    expect(validKey(42)).toBe(false);
  });
});

describe('validEmail', () => {
  it('accepts basic addresses, rejects junk', () => {
    expect(validEmail('a@example.com')).toBe(true);
    expect(validEmail('no-at')).toBe(false);
    expect(validEmail('a@b')).toBe(false);
    expect(validEmail('')).toBe(false);
  });
});

describe('validatePublicPaths', () => {
  it('accepts valid method + rooted pattern', () => {
    expect(validatePublicPaths([{ method: 'get', pattern: '/api/public/**' }]).ok).toBe(true);
    expect(validatePublicPaths([{ method: '*', pattern: '/healthz' }]).ok).toBe(true);
  });
  it('rejects bad methods and unrooted patterns', () => {
    expect(validatePublicPaths([{ method: 'FETCH', pattern: '/x' }]).ok).toBe(false);
    expect(validatePublicPaths([{ method: 'GET', pattern: 'no-slash' }]).ok).toBe(false);
  });
});

describe('validateOverride', () => {
  it('accepts allow and deny (access is binary — no role)', () => {
    expect(validateOverride('allow')).toEqual({ ok: true, value: { effect: 'allow' } });
    expect(validateOverride('deny')).toEqual({ ok: true, value: { effect: 'deny' } });
  });
  it('rejects an invalid effect', () => {
    expect(validateOverride('maybe').ok).toBe(false);
    expect(validateOverride(undefined).ok).toBe(false);
  });
});

describe('parseJson', () => {
  it('parses valid JSON and reports invalid JSON', () => {
    expect(parseJson('[1,2]')).toEqual({ ok: true, value: [1, 2] });
    expect(parseJson('{bad').ok).toBe(false);
  });
});

describe('parseRoster', () => {
  it('drops a header row, trims + lowercases email, trims name', () => {
    const rows = [
      ['Email', 'Name'],
      ['  Alice@Ext.com ', '  Alice  '],
      ['bob@ext.com', 'Bob'],
    ];
    expect(parseRoster(rows)).toEqual([
      { email: 'alice@ext.com', name: 'Alice' },
      { email: 'bob@ext.com', name: 'Bob' },
    ]);
  });

  it('keeps the first row when it is already a valid email (no header)', () => {
    expect(parseRoster([['carol@ext.com', 'Carol']])).toEqual([
      { email: 'carol@ext.com', name: 'Carol' },
    ]);
  });

  it('skips blank rows and rows with an empty first cell; name is optional', () => {
    const rows = [
      ['dave@ext.com'],
      [],
      ['', 'Nobody'],
      ['  ', ''],
      ['erin@ext.com', ''],
    ];
    expect(parseRoster(rows)).toEqual([
      { email: 'dave@ext.com', name: '' },
      { email: 'erin@ext.com', name: '' },
    ]);
  });

  it('does NOT filter invalid emails on data rows (caller reports them per row)', () => {
    // Row 0 "not-an-email" isn't an email → treated as a header and skipped; the
    // data row's invalid email is still returned for the caller to flag.
    const rows = [
      ['not-an-email', 'Header?'],
      ['still-bad', 'X'],
    ];
    expect(parseRoster(rows)).toEqual([{ email: 'still-bad', name: 'X' }]);
  });
});



describe('parseCsvRows', () => {
  it('supports quoted commas, escaped quotes, and CRLF rows', () => {
    expect(parseCsvRows('Email,Name\r\n"a@example.com","Ada, A."\r\n"b@example.com","Bob ""B"""')).toEqual([
      ['Email', 'Name'],
      ['a@example.com', 'Ada, A.'],
      ['b@example.com', 'Bob "B"'],
    ]);
  });
});

describe('decodeCsvBuffer', () => {
  it('decodes UTF-8 and UTF-16 CSV BOMs before parsing', () => {
    const utf8 = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('Email,Name\na@example.com,Ada')]);
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Email,Name\na@example.com,Ada', 'utf16le')]);
    const utf16beBody = Buffer.from('Email,Name\na@example.com,Ada', 'utf16le');
    for (let i = 0; i + 1 < utf16beBody.length; i += 2) {
      const first = utf16beBody[i];
      utf16beBody[i] = utf16beBody[i + 1];
      utf16beBody[i + 1] = first;
    }
    const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody]);

    for (const input of [utf8, utf16le, utf16be]) {
      expect(parseRoster(parseCsvRows(decodeCsvBuffer(input)))).toEqual([{ email: 'a@example.com', name: 'Ada' }]);
    }
  });
});
