import { Response } from 'express';
import { DEFAULT_LANG, translate } from './i18n';

// Flash a message via PRG (post/redirect/get): redirect carrying the text plus a
// severity that the client turns into a colored, auto-dismissing toast (see
// views/partials/foot.ejs). `key` is an i18n key (locales `flash.*`/`validate.*`)
// translated into the viewer's active locale before it is carried on the URL, so
// the toast matches the UI language. Severity is inferred from the message's
// English text so the controlled vocabulary keeps mapping regardless of locale;
// pass `level` explicitly to override when a new message doesn't fit.
export type FlashLevel = 'success' | 'warning' | 'error';

export function inferLevel(msg: string): FlashLevel {
  const m = msg.toLowerCase();
  if (/unchanged|update the deployment|update the app env var|will be unreachable/.test(m)) return 'warning';
  if (/invalid|already exists|cannot|failed|not on the allowlist|unknown|required|not found|\bmust\b/.test(m)) return 'error';
  return 'success';
}

export function flash(res: Response, base: string, key: string, vars?: Record<string, string | number>, level?: FlashLevel): void {
  // res.locals.t is set by the i18n middleware in normal requests; fall back to
  // the default locale when it is absent (e.g. unit tests mount the bare router).
  const t = res.locals?.t as ((k: string, v?: Record<string, string | number>) => string) | undefined;
  const msg = t ? t(key, vars) : translate(DEFAULT_LANG, key, vars);
  const lvl = level || inferLevel(translate(DEFAULT_LANG, key, vars));
  const sep = base.includes('?') ? '&' : '?';
  res.redirect(`${base}${sep}msg=${encodeURIComponent(msg)}&lvl=${lvl}`);
}
