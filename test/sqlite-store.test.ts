import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { openSqlite } from '../src/store/sqlite';
import { Collections, StoreBackend } from '../src/store/types';

// Exercises the SQLite backend against the Mongo-collection semantics the app
// relies on. The route/service tests mock the DB out, so this file is the real
// coverage for the query/update interpreter and the storage layer.

let backend: StoreBackend;
let col: Collections;

beforeEach(async () => {
  backend = openSqlite(':memory:');
  col = backend.col;
  await col.users.createIndex({ email: 1 }, { unique: true });
  await col.usageDaily.createIndex({ user_id: 1, app_key: 1, day: 1 }, { unique: true });
});
afterEach(async () => {
  await backend.close();
});

describe('CRUD + id round-trip', () => {
  it('generates an ObjectId _id and finds by it', async () => {
    const r = await col.users.insertOne({ email: 'a@example.com', roles: [] });
    expect(r.insertedId).toBeInstanceOf(ObjectId);
    const found = await col.users.findOne({ _id: r.insertedId });
    expect(found?.email).toBe('a@example.com');
    expect(found?._id).toBeInstanceOf(ObjectId);
    expect(String(found?._id)).toBe(String(r.insertedId));
  });

  it('keeps an opaque string _id for sessions', async () => {
    await col.sessions.insertOne({ _id: 'sess-abc', user_id: new ObjectId(), expires_at: new Date(Date.now() + 1000) });
    const s = await col.sessions.findOne({ _id: 'sess-abc' });
    expect(s?._id).toBe('sess-abc');
  });

  it('matches an ObjectId filter against a rehydrated id (and by hex string)', async () => {
    const r = await col.users.insertOne({ email: 'b@example.com' });
    expect(await col.users.findOne({ _id: new ObjectId(String(r.insertedId)) })).not.toBeNull();
    expect(await col.users.findOne({ _id: String(r.insertedId) as any })).not.toBeNull();
  });
});

describe('filters', () => {
  beforeEach(async () => {
    await col.roles.insertOne({ key: 'admin', grants: [{ app: 'x' }, { app: 'y' }] });
    await col.roles.insertOne({ key: 'staff', grants: [{ app: 'y' }] });
    await col.users.insertOne({ email: 'u1@example.com', roles: ['admin', 'staff'], status: 'active' });
    await col.users.insertOne({ email: 'u2@example.com', roles: ['staff'], status: 'disabled' });
  });

  it('equality, and array-membership equality', async () => {
    expect((await col.users.find({ status: 'active' }).toArray()).length).toBe(1);
    // { roles: 'admin' } matches when the array contains it
    expect((await col.users.find({ roles: 'admin' }).toArray()).length).toBe(1);
    expect((await col.users.find({ roles: 'staff' }).toArray()).length).toBe(2);
  });

  it('nested array element match (grants.app)', async () => {
    expect((await col.roles.find({ 'grants.app': 'x' }).toArray()).length).toBe(1);
    expect((await col.roles.find({ 'grants.app': 'y' }).toArray()).length).toBe(2);
  });

  it('$in and $gte', async () => {
    expect((await col.roles.find({ key: { $in: ['admin', 'nope'] } }).toArray()).length).toBe(1);
    await col.usageDaily.insertOne({ user_id: new ObjectId(), app_key: 'a', day: '2026-07-01' });
    await col.usageDaily.insertOne({ user_id: new ObjectId(), app_key: 'a', day: '2026-07-08' });
    expect((await col.usageDaily.find({ day: { $gte: '2026-07-05' } }).toArray()).length).toBe(1);
  });

  it('sort, limit, and projection', async () => {
    const rows = await col.users.find().sort({ email: 1 }).limit(1).toArray();
    expect(rows[0].email).toBe('u1@example.com');
    const proj = await col.users.find({ email: 'u1@example.com' }).project({ email: 1 }).toArray();
    expect(proj[0].email).toBe('u1@example.com');
    expect((proj[0] as any).roles).toBeUndefined();
    expect(proj[0]._id).toBeInstanceOf(ObjectId); // _id survives inclusion projection
  });
});

describe('updates', () => {
  it('$set / $push / $pull / $addToSet', async () => {
    const { insertedId: id } = await col.users.insertOne({ email: 'c@example.com', roles: ['a'], app_overrides: [] });
    await col.users.updateOne({ _id: id }, { $set: { name: 'Carol' } });
    await col.users.updateOne({ _id: id }, { $addToSet: { roles: 'a' } }); // no-op (present)
    await col.users.updateOne({ _id: id }, { $addToSet: { roles: 'b' } });
    await col.users.updateOne({ _id: id }, { $push: { app_overrides: { app: 'x', effect: 'allow' } } });
    let u = await col.users.findOne({ _id: id });
    expect(u?.name).toBe('Carol');
    expect(u?.roles).toEqual(['a', 'b']);
    expect((u as any).app_overrides).toEqual([{ app: 'x', effect: 'allow' }]);

    await col.users.updateOne({ _id: id }, { $pull: { roles: 'a' } });
    await col.users.updateOne({ _id: id }, { $pull: { app_overrides: { app: 'x' } } });
    u = await col.users.findOne({ _id: id });
    expect(u?.roles).toEqual(['b']);
    expect((u as any).app_overrides).toEqual([]);
  });

  it('positional $ replaces the matched array element (role rename)', async () => {
    await col.users.insertOne({ email: 'd@example.com', roles: ['old', 'system_admin'] });
    await col.users.insertOne({ email: 'e@example.com', roles: ['staff'] });
    const res = await col.users.updateMany({ roles: 'old' }, { $set: { 'roles.$': 'new' } });
    expect(res.modifiedCount).toBe(1);
    const d = await col.users.findOne({ email: 'd@example.com' });
    expect(d?.roles).toEqual(['new', 'system_admin']);
  });

  it('arrayFilters update a nested sub-document field (app rename)', async () => {
    await col.users.insertOne({ email: 'f@example.com', app_overrides: [{ app: 'old', effect: 'allow' }, { app: 'z', effect: 'deny' }] });
    await col.users.updateMany(
      { 'app_overrides.app': 'old' },
      { $set: { 'app_overrides.$[o].app': 'new' } },
      { arrayFilters: [{ 'o.app': 'old' }] },
    );
    const f = await col.users.findOne({ email: 'f@example.com' });
    expect((f as any).app_overrides).toEqual([{ app: 'new', effect: 'allow' }, { app: 'z', effect: 'deny' }]);
  });

  it('upsert with $setOnInsert then $set on update (usage record idempotency)', async () => {
    const uid = new ObjectId();
    const filter = { user_id: uid, app_key: 'demo', day: '2026-07-08' };
    const first = new Date('2026-07-08T01:00:00Z');
    const later = new Date('2026-07-08T09:00:00Z');
    const r1 = await col.usageDaily.updateOne(filter, { $setOnInsert: { ...filter, first_at: first }, $set: { last_at: first } }, { upsert: true });
    expect(r1.upsertedCount).toBe(1);
    const r2 = await col.usageDaily.updateOne(filter, { $setOnInsert: { ...filter, first_at: later }, $set: { last_at: later } }, { upsert: true });
    expect(r2.upsertedCount).toBe(0);
    expect(r2.matchedCount).toBe(1);
    const rows = await col.usageDaily.find({ app_key: 'demo' }).toArray();
    expect(rows.length).toBe(1); // idempotent on (user, app, day)
    expect(new Date((rows[0] as any).first_at).toISOString()).toBe(first.toISOString());
    expect(new Date((rows[0] as any).last_at).toISOString()).toBe(later.toISOString());
  });
});

describe('deletes and unique indexes', () => {
  it('deleteOne / deleteMany', async () => {
    await col.roles.insertOne({ key: 'r1', grants: [] });
    await col.roles.insertOne({ key: 'r2', grants: [] });
    expect((await col.roles.deleteOne({ key: 'r1' })).deletedCount).toBe(1);
    expect((await col.roles.deleteMany({})).deletedCount).toBe(1);
  });

  it('enforces the unique email index', async () => {
    await col.users.insertOne({ email: 'dup@example.com' });
    await expect(col.users.insertOne({ email: 'dup@example.com' })).rejects.toThrow();
  });
});

describe('date revival + range/exists operators', () => {
  it('revives ISO-datetime fields to Date and supports $gt / $exists', async () => {
    const now = new Date('2026-07-09T12:00:00.000Z');
    const past = new Date('2026-07-01T00:00:00.000Z');
    const future = new Date('2026-08-01T00:00:00.000Z');
    await col.sessions.insertOne({ _id: 's-live', user_id: new ObjectId(), expires_at: future });
    await col.sessions.insertOne({ _id: 's-expired', user_id: new ObjectId(), expires_at: past });
    await col.sessions.insertOne({ _id: 's-revoked', user_id: new ObjectId(), expires_at: future, revoked_at: now });

    const live = await col.sessions.findOne({ _id: 's-live' });
    expect(live?.expires_at).toBeInstanceOf(Date); // revived from JSON, not left a string

    const notExpired = await col.sessions.find({ expires_at: { $gt: now } }).toArray();
    expect(notExpired.map((s) => s._id).sort()).toEqual(['s-live', 's-revoked']);

    const notRevoked = await col.sessions.find({ revoked_at: { $exists: false } }).toArray();
    expect(notRevoked.map((s) => s._id).sort()).toEqual(['s-expired', 's-live']);

    const revoked = await col.sessions.find({ revoked_at: { $exists: true } }).toArray();
    expect(revoked.map((s) => s._id)).toEqual(['s-revoked']);
  });
});

describe('aggregate — $match / $group / $sort / $limit', () => {
  it('counts active days per app and finds the max last_at', async () => {
    const u1 = new ObjectId();
    const u2 = new ObjectId();
    const mk = (user: ObjectId, app: string, day: string, last: string) =>
      col.usageDaily.insertOne({ user_id: user, app_key: app, day, last_at: new Date(last) });
    await mk(u1, 'alpha', '2026-07-01', '2026-07-01T10:00:00Z');
    await mk(u1, 'alpha', '2026-07-02', '2026-07-02T10:00:00Z');
    await mk(u2, 'alpha', '2026-07-02', '2026-07-02T12:00:00Z');
    await mk(u1, 'beta', '2026-07-02', '2026-07-02T08:00:00Z');

    const perApp = await col.usageDaily
      .aggregate<{ _id: string; active: number }>([
        { $match: { day: { $gte: '2026-07-01' } } },
        { $group: { _id: '$app_key', active: { $sum: 1 } } },
        { $sort: { active: -1, _id: 1 } },
      ])
      .toArray();
    expect(perApp).toEqual([
      { _id: 'alpha', active: 3 },
      { _id: 'beta', active: 1 },
    ]);

    const perUser = await col.usageDaily
      .aggregate<{ _id: string; days: number; last: Date }>([
        { $match: { app_key: 'alpha' } },
        { $group: { _id: '$user_id', days: { $sum: 1 }, last: { $max: '$last_at' } } },
        { $sort: { days: -1 } },
        { $limit: 1 },
      ])
      .toArray();
    expect(perUser[0]._id).toBe(String(u1));
    expect(perUser[0].days).toBe(2);
    expect(new Date(perUser[0].last).toISOString()).toBe('2026-07-02T10:00:00.000Z');
  });
});
