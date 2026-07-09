import { z } from './z';
import { User, ApiKey } from '../types';
import * as users from '../services/users';
import * as roles from '../services/roles';
import * as apps from '../services/apps';
import * as rules from '../services/emailRules';

// The single source of truth for the programmatic admin API. Each entry both
// registers an Express route (see api/mount.ts) and contributes a path to the
// generated OpenAPI document (see api/openapi.ts) — add a route here and it shows
// up, validated, in the API and in /admin/docs with nothing else to maintain.

export interface ApiContext {
  user: User; // the key owner; req.user, set by requireApiKey
  apiKey?: ApiKey | null;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
}

export interface RouteDef {
  method: 'get' | 'post';
  path: string; // express-style, relative to /api/admin, e.g. '/users/:id/roles'
  tag: string;
  summary: string;
  params?: z.ZodObject<z.ZodRawShape>;
  query?: z.ZodObject<z.ZodRawShape>;
  body?: z.ZodTypeAny;
  handler: (ctx: ApiContext) => Promise<unknown>;
}

function actor(ctx: ApiContext): string {
  return String(ctx.user._id);
}

const IdParam = z.object({ id: z.string().openapi({ description: 'Mongo ObjectId', example: '64f0c0c0c0c0c0c0c0c0c0c0' }) });
const KeyParam = z.object({ key: z.string().openapi({ description: 'Resource key', example: 'sales' }) });

const RosterRow = z.object({ email: z.string(), name: z.string().optional() });

export const routes: RouteDef[] = [
  // ---- Users ----
  {
    method: 'get', path: '/users', tag: 'Users', summary: 'List/search users (max 200)',
    query: z.object({ q: z.string().optional().openapi({ description: 'Search email or name' }) }),
    handler: (ctx) => users.listUsers(typeof ctx.query.q === 'string' ? ctx.query.q.trim() : undefined),
  },
  {
    method: 'get', path: '/users/:id', tag: 'Users', summary: 'Get one user',
    params: IdParam,
    handler: (ctx) => users.getUser(ctx.params.id),
  },
  {
    method: 'post', path: '/users', tag: 'Users', summary: 'Create a user',
    body: z.object({
      email: z.string().openapi({ example: 'jane@example.com' }),
      name: z.string().optional(),
      department: z.string().optional(),
      roles: z.array(z.string()).optional(),
    }),
    handler: (ctx) => users.createUser(ctx.body as never, actor(ctx)),
  },
  {
    method: 'post', path: '/users/import', tag: 'Users', summary: 'Bulk-provision users from a roster',
    body: z.object({
      roster: z.array(RosterRow),
      role: z.string().optional().openapi({ description: 'Optional ext_* role to assign' }),
      auto_rule: z.boolean().optional().openapi({ description: 'Auto-create exact email-allow rules' }),
      source: z.string().optional().openapi({ description: 'Provenance label for auto-created rules' }),
    }),
    handler: (ctx) => {
      const b = ctx.body as { roster: { email: string; name?: string }[]; role?: string; auto_rule?: boolean; source?: string };
      const roster = (b.roster || []).map((r) => ({ email: String(r.email || '').trim().toLowerCase(), name: String(r.name || '').trim() }));
      return users.importRoster(roster, { role: b.role, autoRule: b.auto_rule, source: b.source }, actor(ctx));
    },
  },
  {
    method: 'post', path: '/users/:id/profile', tag: 'Users', summary: 'Update name/department',
    params: IdParam,
    body: z.object({ name: z.string().optional(), department: z.string().optional() }),
    handler: (ctx) => users.updateProfile(ctx.params.id, ctx.body as never, actor(ctx)),
  },
  {
    method: 'post', path: '/users/:id/roles', tag: 'Users', summary: 'Replace a user\'s roles',
    params: IdParam,
    body: z.object({ roles: z.array(z.string()) }),
    handler: (ctx) => users.setRoles(ctx.params.id, (ctx.body as { roles: string[] }).roles, actor(ctx)),
  },
  {
    method: 'post', path: '/users/:id/overrides', tag: 'Users', summary: 'Set a per-app access override',
    params: IdParam,
    body: z.object({ app: z.string(), effect: z.enum(['allow', 'deny']), reason: z.string().optional() }),
    handler: (ctx) => users.setOverride(ctx.params.id, ctx.body as never, actor(ctx)),
  },
  {
    method: 'post', path: '/users/:id/overrides/delete', tag: 'Users', summary: 'Remove a per-app override',
    params: IdParam,
    body: z.object({ app: z.string() }),
    handler: async (ctx) => { await users.deleteOverride(ctx.params.id, (ctx.body as { app: string }).app, actor(ctx)); return { ok: true }; },
  },
  {
    method: 'post', path: '/users/:id/disable', tag: 'Users', summary: 'Disable a user (revokes sessions)',
    params: IdParam,
    handler: async (ctx) => { await users.disableUser(ctx.params.id, actor(ctx)); return { ok: true }; },
  },
  {
    method: 'post', path: '/users/:id/enable', tag: 'Users', summary: 'Re-enable a user',
    params: IdParam,
    handler: async (ctx) => { await users.enableUser(ctx.params.id, actor(ctx)); return { ok: true }; },
  },
  {
    method: 'post', path: '/users/:id/delete', tag: 'Users', summary: 'Delete a user permanently',
    params: IdParam,
    handler: async (ctx) => { await users.deleteUser(ctx.params.id, actor(ctx)); return { ok: true }; },
  },

  // ---- Roles ----
  { method: 'get', path: '/roles', tag: 'Roles', summary: 'List roles', handler: () => roles.listRoles() },
  { method: 'get', path: '/roles/:key', tag: 'Roles', summary: 'Get one role', params: KeyParam, handler: (ctx) => roles.getRole(ctx.params.key) },
  {
    method: 'post', path: '/roles', tag: 'Roles', summary: 'Create a role',
    body: z.object({ key: z.string(), name: z.string().optional(), description: z.string().optional() }),
    handler: (ctx) => roles.createRole(ctx.body as never, actor(ctx)),
  },
  {
    method: 'post', path: '/roles/:key/edit', tag: 'Roles', summary: 'Edit role name/description',
    params: KeyParam, body: z.object({ name: z.string().optional(), description: z.string().optional() }),
    handler: async (ctx) => { await roles.editRole(ctx.params.key, ctx.body as never, actor(ctx)); return { ok: true }; },
  },
  {
    method: 'post', path: '/roles/:key/rename', tag: 'Roles', summary: 'Rename a role key (cascades to holders)',
    params: KeyParam, body: z.object({ new_key: z.string() }),
    handler: (ctx) => roles.renameRole(ctx.params.key, (ctx.body as { new_key: string }).new_key, actor(ctx)),
  },
  {
    method: 'post', path: '/roles/:key/grants', tag: 'Roles', summary: 'Grant an app to a role',
    params: KeyParam, body: z.object({ app: z.string() }),
    handler: async (ctx) => { await roles.addGrant(ctx.params.key, (ctx.body as { app: string }).app, actor(ctx)); return { ok: true }; },
  },
  {
    method: 'post', path: '/roles/:key/grants/delete', tag: 'Roles', summary: 'Revoke an app grant from a role',
    params: KeyParam, body: z.object({ app: z.string() }),
    handler: async (ctx) => { await roles.deleteGrant(ctx.params.key, (ctx.body as { app: string }).app, actor(ctx)); return { ok: true }; },
  },
  {
    method: 'post', path: '/roles/:key/delete', tag: 'Roles', summary: 'Delete a role (unassigns holders)',
    params: KeyParam,
    handler: (ctx) => roles.deleteRole(ctx.params.key, actor(ctx)),
  },

  // ---- Apps ----
  { method: 'get', path: '/apps', tag: 'Apps', summary: 'List apps', handler: () => apps.listApps() },
  { method: 'get', path: '/apps/:key', tag: 'Apps', summary: 'Get one app', params: KeyParam, handler: (ctx) => apps.getApp(ctx.params.key) },
  {
    method: 'post', path: '/apps', tag: 'Apps', summary: 'Register an app',
    body: z.object({ key: z.string(), name: z.string().optional(), description: z.string().optional() }),
    handler: (ctx) => apps.createApp(ctx.body as never, actor(ctx)),
  },
  {
    method: 'post', path: '/apps/:key', tag: 'Apps', summary: 'Update an app',
    params: KeyParam,
    body: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['active', 'disabled', 'planned']).optional(),
      public_paths: z.array(z.object({ method: z.string(), pattern: z.string() })).optional(),
      default_base_url: z.string().optional(),
    }),
    handler: async (ctx) => { await apps.updateApp(ctx.params.key, ctx.body as never, actor(ctx)); return { ok: true }; },
  },
  {
    method: 'post', path: '/apps/:key/rename', tag: 'Apps', summary: 'Rename an app key (cascades)',
    params: KeyParam, body: z.object({ new_key: z.string() }),
    handler: (ctx) => apps.renameApp(ctx.params.key, (ctx.body as { new_key: string }).new_key, actor(ctx)),
  },
  {
    method: 'post', path: '/apps/:key/delete', tag: 'Apps', summary: 'Delete an app',
    params: KeyParam,
    handler: (ctx) => apps.deleteApp(ctx.params.key, actor(ctx)),
  },
  {
    method: 'post', path: '/apps/:key/regenerate-secret', tag: 'Apps', summary: 'Rotate the proxy secret',
    params: KeyParam,
    handler: (ctx) => apps.regenerateSecret(ctx.params.key, actor(ctx)),
  },

  // ---- Email allow rules ----
  { method: 'get', path: '/email-rules', tag: 'Email rules', summary: 'List email allow rules', handler: () => rules.listRules() },
  {
    method: 'post', path: '/email-rules', tag: 'Email rules', summary: 'Create an allow rule',
    body: z.object({ type: z.enum(['exact', 'domain']), pattern: z.string(), description: z.string().optional() }),
    handler: (ctx) => rules.createRule(ctx.body as never, actor(ctx)),
  },
  {
    method: 'post', path: '/email-rules/:id/description', tag: 'Email rules', summary: 'Edit a rule description',
    params: IdParam, body: z.object({ description: z.string() }),
    handler: async (ctx) => { await rules.updateDescription(ctx.params.id, (ctx.body as { description: string }).description, actor(ctx)); return { ok: true }; },
  },
  {
    method: 'post', path: '/email-rules/:id/toggle', tag: 'Email rules', summary: 'Enable/disable a rule',
    params: IdParam,
    handler: (ctx) => rules.toggleRule(ctx.params.id, actor(ctx)),
  },
  {
    method: 'post', path: '/email-rules/:id/delete', tag: 'Email rules', summary: 'Delete a rule',
    params: IdParam,
    handler: async (ctx) => { await rules.deleteRule(ctx.params.id, actor(ctx)); return { ok: true }; },
  },

  // ---- Audit ----
  {
    method: 'get', path: '/audit', tag: 'Audit', summary: 'Recent audit log (max 200)',
    handler: () => rules.listAudit(),
  },
];
