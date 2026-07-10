import { MongoClient, Db } from 'mongodb';
import { config } from './config';
import { Collections, StoreBackend } from './store/types';
import { openSqlite } from './store/sqlite';
import { refreshProviderConfig } from './idp/config';

// The app talks to `col` — a backend-agnostic set of collections (see
// src/store/types.ts). SQLite is the default/primary backend (a file on disk);
// setting MONGODB_CONN_STR switches to MongoDB. Both implement the same narrow
// collection API, so nothing else in the app changes between them.

export type { Collections } from './store/types';

export let col: Collections;

let mongoClient: MongoClient | null = null;
let sqliteBackend: StoreBackend | null = null;

export function usingSqlite(): boolean {
  return !config.mongoUri;
}

export async function connect(): Promise<void> {
  if (config.mongoUri) {
    mongoClient = new MongoClient(config.mongoUri, {
      maxPoolSize: config.mongoMaxPoolSize,
      minPoolSize: config.mongoMinPoolSize,
    });
    await mongoClient.connect();
    const db: Db = mongoClient.db(config.mongoDb);
    // A real driver Collection satisfies the narrow ICollection at runtime.
    col = {
      users: db.collection('users'),
      roles: db.collection('roles'),
      apps: db.collection('apps'),
      emailRules: db.collection('email_allow_rules'),
      sessions: db.collection('sessions'),
      audit: db.collection('audit_logs'),
      usageDaily: db.collection('usage_daily'),
      apiKeys: db.collection('api_keys'),
    } as unknown as Collections;
  } else {
    sqliteBackend = openSqlite(config.sqlitePath);
    col = sqliteBackend.col;
  }
  await ensureIndexes();
  // Resolve identity-provider config from the environment into its cache so the
  // synchronous provider gates are populated before any request is served.
  refreshProviderConfig();
}

// Index/uniqueness contract, applied to whichever backend is active. On SQLite,
// createIndex also registers a generated column for each field (see store/sqlite).
export async function ensureIndexes(): Promise<void> {
  await col.users.createIndex({ email: 1 }, { unique: true });
  await col.users.createIndex({ logto_user_id: 1 }, { unique: true, sparse: true });
  await col.roles.createIndex({ key: 1 }, { unique: true });
  await col.apps.createIndex({ key: 1 }, { unique: true });
  await col.emailRules.createIndex({ type: 1, pattern: 1 });
  // Sliding idle expiry: on Mongo the TTL index removes the session when
  // expires_at passes; on SQLite the store sweeps expired rows (TTL is a no-op).
  await col.sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await col.sessions.createIndex({ user_id: 1 });
  await col.audit.createIndex({ created_at: -1 });
  // Usage: unique (user, app, day) is the idempotency key and the per-user/app
  // totals index; the two secondaries serve per-app reads and per-user heatmaps.
  await col.usageDaily.createIndex({ user_id: 1, app_key: 1, day: 1 }, { unique: true });
  await col.usageDaily.createIndex({ app_key: 1, day: 1 });
  await col.usageDaily.createIndex({ user_id: 1, day: 1 });
  // API keys: hash lookup is the auth hot path (unique); per-owner index serves
  // the admin's "my keys" list.
  await col.apiKeys.createIndex({ token_hash: 1 }, { unique: true });
  await col.apiKeys.createIndex({ user_id: 1 });
}

export async function close(): Promise<void> {
  if (mongoClient) await mongoClient.close();
  if (sqliteBackend) await sqliteBackend.close();
  mongoClient = null;
  sqliteBackend = null;
}
