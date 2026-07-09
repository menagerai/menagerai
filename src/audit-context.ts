import { AsyncLocalStorage } from 'async_hooks';

// Request-scoped audit channel. The API auth middleware runs the rest of the
// request inside `run({ via: 'api', ... })`, and audit() reads the current store
// to stamp every entry with how the action was triggered — so the shared services
// don't need to know or pass through the channel. Absent store ⇒ a UI action.
export interface AuditContext {
  via: 'ui' | 'api';
  apiKeyId?: string;
  apiKeyName?: string;
}

export const auditContext = new AsyncLocalStorage<AuditContext>();

export function runWithAuditContext<T>(ctx: AuditContext, fn: () => T): T {
  return auditContext.run(ctx, fn);
}
