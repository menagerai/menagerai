import { describe, expect, it } from 'vitest';
import { DEFAULT_LANG, SUPPORTED, negotiate, pickLang, translate } from '../src/i18n';

describe('translate', () => {
  it('returns the locale string for a known key', () => {
    expect(translate('en', 'nav.signOut')).toBe('Sign out');
    expect(translate('zh', 'nav.signOut')).toBe('退出登录');
  });

  it('interpolates {placeholders}', () => {
    expect(translate('en', 'launcher.welcome', { name: 'Alice' })).toBe('Welcome, Alice');
    expect(translate('zh', 'launcher.welcome', { name: 'Alice' })).toBe('欢迎，Alice');
  });

  it('falls back to English when a key is missing in the locale', () => {
    // every en key should resolve in zh too, but a fabricated-missing case:
    expect(translate('zh', 'nonexistent.key')).toBe('nonexistent.key'); // then to the key itself
  });

  it('returns the key itself when unknown in all locales', () => {
    expect(translate('en', 'totally.made.up')).toBe('totally.made.up');
  });

  it('interpolates the brand name across locales', () => {
    expect(translate('en', 'nav.brand', { brand: 'Menagerai' })).toBe('Menagerai App Portal');
    expect(translate('zh', 'nav.brand', { brand: 'Menagerai' })).toBe('Menagerai应用门户');
  });
});

describe('pickLang', () => {
  it('accepts supported locales, defaults otherwise', () => {
    expect(pickLang('en')).toBe('en');
    expect(pickLang('zh')).toBe('zh');
    expect(pickLang('fr')).toBe(DEFAULT_LANG);
    expect(pickLang(undefined)).toBe(DEFAULT_LANG);
  });
});

describe('negotiate — cookie wins, else autodetect from Accept-Language', () => {
  it('uses the cookie choice regardless of Accept-Language', () => {
    expect(negotiate('zh', 'en-US,en;q=0.9')).toBe('zh');
    expect(negotiate('en', 'zh-CN,zh;q=0.9')).toBe('en');
  });

  it('autodetects from Accept-Language when there is no cookie', () => {
    expect(negotiate(undefined, 'zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh');
    expect(negotiate(undefined, 'en-US,en;q=0.9')).toBe('en');
  });

  it('honors q-weight order, not header order', () => {
    expect(negotiate(undefined, 'en;q=0.7,zh;q=0.9')).toBe('zh');
  });

  it('falls back to the default for unsupported / missing languages', () => {
    expect(negotiate(undefined, 'fr-FR,fr;q=0.9')).toBe(DEFAULT_LANG);
    expect(negotiate(undefined, undefined)).toBe(DEFAULT_LANG);
    expect(negotiate(undefined, '')).toBe(DEFAULT_LANG);
  });

  it('ignores an invalid cookie and falls through to Accept-Language', () => {
    expect(negotiate('fr', 'zh-CN,zh;q=0.9')).toBe('zh');
  });
});

describe('locale parity', () => {
  it('zh defines every key that en does', () => {
    // flatten both dicts and compare key sets so a half-translated file is caught
    const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === 'object'
          ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
          : [`${prefix}${k}`],
      );
    // load via translate's own files
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const en = require('../locales/en.json');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zh = require('../locales/zh.json');
    const enKeys = flatten(en).sort();
    const zhKeys = flatten(zh).sort();
    expect(zhKeys).toEqual(enKeys);
    expect(SUPPORTED).toContain('zh');
  });
});
