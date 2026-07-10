import fs from 'fs';
import path from 'path';
import { NextFunction, Request, Response } from 'express';

// Minimal file-based i18n. Each locale is one editor-friendly JSON file under
// /locales (nested keys by area). Templates call t('area.key'); missing keys
// fall back to English, then to the key itself, so a partial translation never
// breaks a page. Optional {placeholder} interpolation via the vars arg.
export const SUPPORTED = ['en', 'zh'] as const;
export type Lang = (typeof SUPPORTED)[number];
export const DEFAULT_LANG: Lang = 'en';
export const LANG_COOKIE = 'menagerai_lang';

const LOCALES_DIR = path.resolve(__dirname, '..', 'locales');

type Dict = Record<string, unknown>;
const dicts: Record<string, Dict> = {};
for (const l of SUPPORTED) {
  try {
    dicts[l] = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${l}.json`), 'utf8')) as Dict;
  } catch (err) {
    console.error(`i18n: failed to load locale ${l}`, err);
    dicts[l] = {};
  }
}

function lookup(dict: Dict | undefined, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as object)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function translate(lang: string, key: string, vars?: Record<string, string | number>): string {
  let s = lookup(dicts[lang], key) ?? lookup(dicts[DEFAULT_LANG], key) ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

// Normalize an arbitrary value to a supported locale (else the default).
export function pickLang(raw: unknown): Lang {
  return (SUPPORTED as readonly string[]).includes(String(raw)) ? (raw as Lang) : DEFAULT_LANG;
}

// Parse an Accept-Language header into base language codes (e.g. "zh-CN" → "zh"),
// ordered by q-weight (highest first; equal weights keep header order).
function parseAcceptLanguage(header?: string | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? parseFloat(qParam.split('=')[1]) : 1;
      return { base: tag.trim().toLowerCase().split('-')[0], q: Number.isFinite(q) ? q : 1 };
    })
    .filter((x) => x.base && x.base !== '*')
    .sort((a, b) => b.q - a.q)
    .map((x) => x.base);
}

// Resolve the active locale: an explicit cookie choice wins; otherwise auto-detect
// from the browser's Accept-Language; otherwise the default. Pure/testable.
export function negotiate(cookieVal: unknown, acceptHeader?: string | null): Lang {
  if ((SUPPORTED as readonly string[]).includes(String(cookieVal))) return cookieVal as Lang;
  for (const base of parseAcceptLanguage(acceptHeader)) {
    if ((SUPPORTED as readonly string[]).includes(base)) return base as Lang;
  }
  return DEFAULT_LANG;
}

// Resolve the active locale and expose `t` + `lang` to all templates.
export function i18n(req: Request, res: Response, next: NextFunction): void {
  const lang = negotiate(req.cookies?.[LANG_COOKIE], req.get('accept-language'));
  res.locals.lang = lang;
  res.locals.t = (key: string, vars?: Record<string, string | number>): string => translate(lang, key, vars);
  next();
}
