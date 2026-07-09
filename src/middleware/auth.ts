import { NextFunction, Request, Response } from 'express';
import { userCached } from '../decide';
import { getSessionId, sessionIsRevoked, touchSession } from '../sessions';
import { User } from '../types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User | null;
      sessionId?: string;
      sessionRevoked?: boolean;
    }
  }
}

// Resolves the session cookie → ACP user, attaching req.user (or null). Never
// blocks; route guards decide what to do when there is no user.
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  req.user = null;
  const sid = getSessionId(req);
  if (!sid) return next();
  const session = await touchSession(sid, { ip: req.ip, ua: req.get('user-agent') });
  if (!session) {
    // No live session for this cookie — flag it if it's a revoked tombstone, so the
    // login redirect can force an interactive login instead of a silent SSO re-auth.
    req.sessionRevoked = await sessionIsRevoked(sid);
    return next();
  }
  const user = await userCached(session.user_id);
  if (user && user.status === 'active') {
    req.user = user;
    req.sessionId = sid;
  }
  next();
}

function wantsHtml(req: Request): boolean {
  if (req.get('sec-fetch-mode') === 'navigate') return true;
  return (req.get('accept') || '').includes('text/html');
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (req.user) return next();
  if (wantsHtml(req)) {
    const next_ = encodeURIComponent(req.originalUrl);
    const force = req.sessionRevoked ? '&force=1' : '';
    res.redirect(`/login?next=${next_}${force}`);
  } else {
    res.status(401).json({ error: 'unauthenticated', login_url: '/login' });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user && req.user.roles?.includes('system_admin')) return next();
  if (!req.user) return requireSession(req, res, next);
  res.status(403).send('Forbidden: system_admin role required.');
}
