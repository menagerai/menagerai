import { Router } from 'express';
import { ZodError } from 'zod';
import { requireApiKey } from '../middleware/apiKeyAuth';
import { ApiContext, routes } from './registry';
import { isApiError, NotFoundError } from '../services/errors';

// Build the API-key-gated JSON admin router from the route registry. Each entry's
// zod schemas validate the request (→ 400 with issues) before its handler runs;
// service ApiErrors map to their HTTP status, everything else to 500.
export function buildApiRouter(): Router {
  const router = Router();
  router.use(requireApiKey);

  for (const def of routes) {
    router[def.method](def.path, async (req, res) => {
      try {
        const params = def.params ? def.params.parse(req.params) : req.params;
        const query = def.query ? def.query.parse(req.query) : req.query;
        const body = def.body ? def.body.parse(req.body ?? {}) : (req.body ?? {});
        const ctx: ApiContext = {
          user: req.user!,
          apiKey: req.apiKey,
          params: params as Record<string, string>,
          query: query as Record<string, unknown>,
          body: body as Record<string, unknown>,
        };
        const result = await def.handler(ctx);
        res.json(result ?? { ok: true });
      } catch (err) {
        if (err instanceof ZodError) {
          res.status(400).json({ error: 'invalid_request', issues: err.issues });
          return;
        }
        if (err instanceof NotFoundError) {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        if (isApiError(err)) {
          res.status(err.status).json({ error: err.i18nKey, ...(err.vars ? { vars: err.vars } : {}) });
          return;
        }
        console.error('api handler error', err);
        res.status(500).json({ error: 'internal_error' });
      }
    });
  }

  return router;
}
