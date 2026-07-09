import crypto from 'crypto';
import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { config } from './config';
import { col } from './db';
import { SessionDoc, User } from './types';

function newId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// Per-session device fingerprint captured at login and refreshed on activity.
export interface SessionMeta {
  ip?: string;
  ua?: string;
}

// Cap the stored UA so a hostile or absurd User-Agent can't bloat the doc.
const UA_MAX = 512;
function cleanUa(ua?: string): string | undefined {
  if (!ua) return undefined;
  const s = ua.trim();
  return s ? s.slice(0, UA_MAX) : undefined;
}

// How often touchSession persists a fresh last_seen_at / ip / user_agent. Kept
// independent of the idle-slide throttle below: under active use the idle slide
// rarely fires (each touch only bumps a minute or two), so folding last-seen into
// it would let the displayed "last active" go stale.
const SEEN_REFRESH_MS = 60 * 1000;

export async function createSession(user: User, meta: SessionMeta = {}): Promise<string> {
  const now = Date.now();
  const id = newId();
  const doc: SessionDoc = {
    _id: id,
    user_id: user._id as ObjectId,
    email: user.email,
    logto_sub: user.logto_user_id || undefined,
    created_at: new Date(now),
    expires_at: new Date(now + config.session.idleSeconds * 1000),
    absolute_expiry: new Date(now + config.session.absoluteSeconds * 1000),
    ip: meta.ip || undefined,
    user_agent: cleanUa(meta.ua),
    last_seen_at: new Date(now),
  };
  await col.sessions.insertOne(doc);
  return id;
}

// PURE: is this session expired at time `nowMs` (idle OR absolute cap)?
export function sessionExpired(s: Pick<SessionDoc, 'expires_at' | 'absolute_expiry'>, nowMs: number): boolean {
  return s.expires_at.getTime() <= nowMs || s.absolute_expiry.getTime() <= nowMs;
}

// Returns the session doc if valid, sliding the idle expiry forward (at most
// once per ~5 min to avoid a write on every request). Enforces the absolute cap.
export async function touchSession(id: string, meta: SessionMeta = {}): Promise<SessionDoc | null> {
  const s = await col.sessions.findOne({ _id: id });
  if (!s) return null;
  if (s.revoked_at) return null; // revoked tombstone — treat as no session
  const now = Date.now();
  if (sessionExpired(s, now)) {
    await col.sessions.deleteOne({ _id: id });
    return null;
  }
  const set: Partial<SessionDoc> = {};
  const nextIdle = now + config.session.idleSeconds * 1000;
  const capped = Math.min(nextIdle, s.absolute_expiry.getTime());
  // Slide the idle expiry, but only persist if we'd extend by more than 5 minutes.
  if (capped - s.expires_at.getTime() > 5 * 60 * 1000) {
    set.expires_at = new Date(capped);
  }
  // Refresh the device fingerprint on its own (looser) throttle so "last active"
  // and the latest IP stay fresh even while the idle slide is being suppressed.
  const lastSeen = s.last_seen_at?.getTime() ?? s.created_at.getTime();
  if (now - lastSeen > SEEN_REFRESH_MS) {
    set.last_seen_at = new Date(now);
    if (meta.ip) set.ip = meta.ip;
    const ua = cleanUa(meta.ua);
    if (ua) set.user_agent = ua;
  }
  if (Object.keys(set).length > 0) {
    // Best-effort, non-blocking: this write only slides the idle expiry and
    // refreshes the device fingerprint. The request already holds the (read) doc
    // it needs to know the session is valid, so don't make a passing request —
    // including every linked-app gateway verify — wait on the DB round-trip.
    void col.sessions.updateOne({ _id: id }, { $set: set }).catch((err) => {
      console.error('touchSession refresh failed', err);
    });
  }
  return s;
}

export async function destroySession(id: string): Promise<void> {
  await col.sessions.deleteOne({ _id: id });
}

// Revoke a session belonging to `userId` by tombstoning it (not deleting), so a
// browser still holding the cookie is forced through an interactive login rather
// than silently re-authenticating via its IdP SSO cookie. Returns whether a live
// session was revoked (false = not found / not theirs / already revoked).
export async function revokeSession(id: string, userId: ObjectId): Promise<boolean> {
  const now = new Date();
  const result = await col.sessions.updateOne(
    { _id: id, user_id: userId, revoked_at: { $exists: false } },
    { $set: { revoked_at: now, last_seen_at: now } },
  );
  return result.modifiedCount > 0;
}

// True if the given session id refers to a revoked tombstone (used to force an
// interactive login on the next request from that browser).
export async function sessionIsRevoked(id: string): Promise<boolean> {
  const s = await col.sessions.findOne({ _id: id, revoked_at: { $exists: true } });
  return Boolean(s);
}

export async function destroyUserSessions(userId: ObjectId): Promise<void> {
  await col.sessions.deleteMany({ user_id: userId });
}

export function setSessionCookie(res: Response, id: string): void {
  res.cookie(config.session.cookieName, id, {
    httpOnly: true,
    secure: config.session.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: config.session.absoluteSeconds * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(config.session.cookieName, { path: '/' });
}

export function getSessionId(req: Request): string | undefined {
  return req.cookies?.[config.session.cookieName];
}
