import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { config } from '../config';
import { routes } from './registry';

// Express `:param` → OpenAPI `{param}`.
function toOpenApiPath(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

// Derive the OpenAPI 3.1 document straight from the route registry — the same
// definitions that mount the live routes — so the spec can never drift from the
// implementation (FastAPI-style). Memoized: the registry is static.
let cached: ReturnType<OpenApiGeneratorV31['generateDocument']> | null = null;

export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  if (cached) return cached;
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'ApiKeyAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Admin API key. Send "Authorization: Bearer dvk_…" or the "X-API-Key" header. Create keys under Admin → API access.',
  });

  for (const def of routes) {
    registry.registerPath({
      method: def.method,
      path: '/api/admin' + toOpenApiPath(def.path),
      summary: def.summary,
      tags: [def.tag],
      security: [{ ApiKeyAuth: [] }],
      request: {
        ...(def.params ? { params: def.params } : {}),
        ...(def.query ? { query: def.query } : {}),
        ...(def.body ? { body: { content: { 'application/json': { schema: def.body } } } } : {}),
      },
      responses: {
        200: { description: 'Success' },
        400: { description: 'Invalid request' },
        401: { description: 'Missing or invalid API key' },
        403: { description: 'Key owner is not an active admin, or the action is forbidden' },
        404: { description: 'Not found' },
      },
    });
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  cached = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: `${config.brandName} Admin API`,
      version: '0.1.0',
      description:
        `Programmatic access to every admin action in ${config.brandName}, ` +
        'authenticated with a personal admin API key. A key carries the full admin power ' +
        'of its owner; treat it like a password.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'Users' }, { name: 'Roles' }, { name: 'Apps' }, { name: 'Email rules' }, { name: 'Audit' },
    ],
  });
  return cached;
}
