import path from 'path';
import cookieParser from 'cookie-parser';
import express from 'express';
import { config } from './config';
import { i18n } from './i18n';
import { formatInstant } from './util';
import { loadUser } from './middleware/auth';
import { accessRouter } from './routes/access';
import { authRouter } from './routes/auth';
import { gatewayRouter } from './routes/gateway';
import { portalRouter } from './routes/portal';
import { adminRouter } from './routes/admin';
import { buildApiRouter } from './api/mount';
import { StartupCheck } from './startup';
import { demoAuthRouter } from './demo/auth';
import { demoLocals } from './demo/reset';

// Shared tail handlers: an explicit 404 so an unmatched path (e.g. /gateway/verify
// when it is NOT mounted) returns "Not found" rather than falling through, plus a
// catch-all error handler.
function attachTail(app: express.Express): void {
  app.use((_req, res) => res.status(404).send('Not found'));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('unhandled error', err);
    res.status(500).send('Internal error');
  });
}

// The public portal app: launcher, auth, admin UI, access API. Listens on the
// public-routed port. /gateway/verify is mounted here only when opts.mountGateway
// is set (legacy/additive rollout) — the secure end-state serves verify solely on
// the internal gateway app below.
export function buildPublicApp(opts: { mountGateway: boolean; startup: StartupCheck }): express.Express {
  const app = express();
  app.set('trust proxy', true);
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', 'views'));

  app.use(cookieParser());
  app.use(i18n); // resolve locale from the menagerai_lang cookie → res.locals.t / .lang
  // Inject the brand name into every template + locale string. i18n strings carry
  // a {brand} placeholder; wrapping t() here means each call resolves it from
  // config.brandName without every call site having to pass it. Also exposed as
  // `brand` for direct use in views.
  app.use((_req, res, next) => {
    res.locals.brand = config.brandName;
    const t = res.locals.t as (key: string, vars?: Record<string, string | number>) => string;
    res.locals.t = (key: string, vars?: Record<string, string | number>) =>
      t(key, { brand: config.brandName, ...(vars || {}) });
    next();
  });
  // Expose a timezone-aware time formatter to every template. Stored instants are
  // UTC; templates render them in the configured display zone (config.timezone).
  app.use((_req, res, next) => {
    res.locals.fmtTime = (value: Date | string | number | null | undefined, opts?: { seconds?: boolean }) =>
      formatInstant(value, config.timezone, opts);
    next();
  });
  // Demo mode: expose demoMode + next-reset epoch to every template (countdown
  // banner in partials/head.ejs). Before the routers so every render sees it.
  if (config.demoMode) app.use(demoLocals);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  // Public static assets (favicon, etc.) — served before auth, no identity needed.
  app.use(express.static(path.resolve(__dirname, '..', 'public'), { maxAge: '1d' }));
  app.use(loadUser);

  // Startup config gate: when the Logto env/connection preflight failed, serve a
  // plain-language configuration screen for every page instead of the portal —
  // except /healthz (so the container stays up and doesn't crash-loop) and
  // /gateway (so ForwardAuth gets a real verify response, not an HTML page).
  if (!opts.startup.ok) {
    app.use((req, res, next) => {
      const p = req.path;
      if (p === '/healthz' || p.startsWith('/gateway')) return next();
      res.status(503).render('config-error', {
        title: 'Configuration required',
        problems: opts.startup.problems,
        checkedAt: opts.startup.checkedAt,
      });
    });
  }

  if (opts.mountGateway) app.use(gatewayRouter); // /gateway/verify
  // Demo mode swaps OIDC sign-in for the persona picker at the same /login,/logout
  // paths, so every existing redirect keeps working.
  app.use(config.demoMode ? demoAuthRouter : authRouter); // /login /callback /logout
  app.use(accessRouter); // /api/access/*
  app.use('/api/admin', buildApiRouter()); // programmatic admin API (API-key auth) → JSON
  app.use('/admin', adminRouter); // admin UI + actions
  app.use(portalRouter); // / launcher, /no-access, /healthz

  attachTail(app);
  return app;
}

// The internal gateway app: serves ONLY /gateway/verify (the Traefik ForwardAuth
// target). Listens on config.gatewayPort, which no FQDN routes to. Minimal stack —
// verify renders nothing and reads no body; it needs cookies (loadUser) and the
// X-Forwarded-* headers only.
export function buildGatewayApp(): express.Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(loadUser);
  app.use(gatewayRouter); // /gateway/verify
  attachTail(app);
  return app;
}
