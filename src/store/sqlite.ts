import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { ObjectId } from 'mongodb';
import {
  AggCursor,
  Collections,
  DeleteResult,
  FindCursor,
  ICollection,
  IndexOptions,
  InsertOneResult,
  StoreBackend,
  UpdateResult,
} from './types';
import { applyUpdate, buildUpsertDoc, Doc, Filter, matches, norm, projectDoc, sortDocs, UpdateDoc } from './mongoql';

// A document store on SQLite: each collection is a table `(id TEXT PRIMARY KEY,
// doc TEXT)` holding the JSON document. Queried/indexed fields are exposed as
// VIRTUAL generated columns so real (unique) indexes back them; everything else
// is matched in JS via the query interpreter. This mirrors the Mongo collection
// semantics the app relies on without a networked database — the primary store
// for a single-container deployment. See query.ts for the supported operators.

type IdType = 'objectId' | 'string';

interface Row {
  id: string;
  doc: Doc;
}

// JSON.stringify(Date) emits an ISO-8601 UTC string; revive those back to Date on
// read so SQLite docs carry the same field types the Mongo backend returns (the app
// calls Date methods on e.g. session.expires_at). Date-only strings ('YYYY-MM-DD',
// the usage `day`) have no 'T' and stay strings; hex ids never match either.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
function reviveDates(v: any): any {
  if (typeof v === 'string') return ISO_DATETIME.test(v) ? new Date(v) : v;
  if (Array.isArray(v)) return v.map(reviveDates);
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = reviveDates(v[k]);
  }
  return v;
}

class SqliteCollection<T> implements ICollection<T> {
  private gcols = new Set<string>();

  constructor(
    private db: Database.Database,
    private table: string,
    private idType: IdType,
  ) {}

  // --- id handling ---------------------------------------------------------

  private hydrate(raw: string): Doc {
    const doc = reviveDates(JSON.parse(raw)) as Doc;
    if (this.idType === 'objectId' && typeof doc._id === 'string') doc._id = new ObjectId(doc._id);
    return doc;
  }

  private idString(doc: Doc): string {
    return this.idType === 'objectId' ? new ObjectId(doc._id as any).toHexString() : String(doc._id);
  }

  // --- read ----------------------------------------------------------------

  // Build a partial SQL prefilter from the filter keys that map to the id column
  // or a generated column with a scalar / $in / $gte condition; correctness still
  // comes from the JS matches() applied to the returned rows.
  private prefilter(filter: Filter): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [key, cond] of Object.entries(filter)) {
      const column = key === '_id' ? 'id' : this.gcols.has(key) ? `"${key}"` : null;
      if (!column) continue;
      if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !(cond as any)._bsontype && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>;
        if ('$in' in c) {
          const arr = c.$in as unknown[];
          if (arr.length === 0) return { where: '0', params: [] };
          clauses.push(`${column} IN (${arr.map(() => '?').join(',')})`);
          params.push(...arr.map((v) => norm(v)));
        } else if ('$gte' in c) {
          clauses.push(`${column} >= ?`);
          params.push(norm(c.$gte));
        }
      } else {
        clauses.push(`${column} = ?`);
        params.push(norm(cond));
      }
    }
    return { where: clauses.length ? clauses.join(' AND ') : '1', params };
  }

  private selectMatching(filter: Filter): Row[] {
    const { where, params } = this.prefilter(filter);
    const raw = this.db.prepare(`SELECT id, doc FROM ${this.table} WHERE ${where}`).all(...(params as any[])) as {
      id: string;
      doc: string;
    }[];
    const rows = raw.map((r) => ({ id: r.id, doc: this.hydrate(r.doc) }));
    return rows.filter((r) => matches(r.doc, filter));
  }

  async findOne(filter: Filter = {}): Promise<T | null> {
    const rows = this.selectMatching(filter);
    return (rows[0]?.doc as T) ?? null;
  }

  find(filter: Filter = {}, options?: { projection?: Record<string, 0 | 1> }): FindCursor<T> {
    const self = this;
    let projection = options?.projection;
    let sortSpec: Record<string, 1 | -1> | undefined;
    let lim: number | undefined;
    const cursor: FindCursor<T> = {
      sort(spec) {
        sortSpec = spec;
        return cursor;
      },
      limit(n) {
        lim = n;
        return cursor;
      },
      project(spec) {
        projection = spec;
        return cursor;
      },
      async toArray() {
        let docs = self.selectMatching(filter).map((r) => r.doc);
        if (sortSpec) docs = sortDocs(docs, sortSpec);
        if (lim != null) docs = docs.slice(0, lim);
        if (projection) docs = docs.map((d) => projectDoc(d, projection));
        return docs as T[];
      },
    };
    return cursor;
  }

  // --- write ---------------------------------------------------------------

  private insertRaw(doc: Doc): ObjectId | string {
    if (doc._id == null && this.idType === 'objectId') doc._id = new ObjectId();
    const id = this.idString(doc);
    this.db.prepare(`INSERT INTO ${this.table} (id, doc) VALUES (?, ?)`).run(id, JSON.stringify(doc));
    return doc._id;
  }

  async insertOne(doc: any): Promise<InsertOneResult> {
    const insertedId = this.insertRaw({ ...doc });
    return { acknowledged: true, insertedId: insertedId as ObjectId };
  }

  private persist(id: string, doc: Doc): void {
    this.db.prepare(`UPDATE ${this.table} SET doc = ? WHERE id = ?`).run(JSON.stringify(doc), id);
  }

  private update(filter: Filter, update: UpdateDoc, opts: { upsert?: boolean; arrayFilters?: Filter[] }, many: boolean): UpdateResult {
    const run = this.db.transaction((): UpdateResult => {
      const rows = this.selectMatching(filter);
      const targets = many ? rows : rows.slice(0, 1);
      for (const r of targets) {
        applyUpdate(r.doc, update, filter, opts.arrayFilters || []);
        this.persist(r.id, r.doc);
      }
      if (targets.length === 0 && opts.upsert) {
        const fresh = buildUpsertDoc(filter, update);
        const insertedId = this.insertRaw(fresh);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: insertedId as ObjectId };
      }
      return { acknowledged: true, matchedCount: targets.length, modifiedCount: targets.length, upsertedCount: 0, upsertedId: null };
    });
    return run();
  }

  async updateOne(filter: Filter, update: UpdateDoc, options: { upsert?: boolean; arrayFilters?: Filter[] } = {}): Promise<UpdateResult> {
    return this.update(filter, update, options, false);
  }

  async updateMany(filter: Filter, update: UpdateDoc, options: { upsert?: boolean; arrayFilters?: Filter[] } = {}): Promise<UpdateResult> {
    return this.update(filter, update, options, true);
  }

  private delete(filter: Filter, many: boolean): DeleteResult {
    const rows = this.selectMatching(filter);
    const targets = many ? rows : rows.slice(0, 1);
    const del = this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`);
    const run = this.db.transaction(() => {
      for (const r of targets) del.run(r.id);
    });
    run();
    return { acknowledged: true, deletedCount: targets.length };
  }

  async deleteOne(filter: Filter): Promise<DeleteResult> {
    return this.delete(filter, false);
  }

  async deleteMany(filter: Filter): Promise<DeleteResult> {
    return this.delete(filter, true);
  }

  // --- aggregate (subset: $match, $group, $sort, $limit) -------------------

  aggregate<R = any>(pipeline: any[]): AggCursor<R> {
    const first = pipeline[0];
    let rows: Doc[] =
      first && first.$match ? this.selectMatching(first.$match).map((r) => r.doc) : this.selectMatching({}).map((r) => r.doc);
    const stages = first && first.$match ? pipeline.slice(1) : pipeline;

    for (const stage of stages) {
      if (stage.$match) {
        rows = rows.filter((d) => matches(d, stage.$match));
      } else if (stage.$group) {
        rows = groupStage(rows, stage.$group);
      } else if (stage.$sort) {
        rows = sortDocs(rows, stage.$sort);
      } else if (stage.$limit != null) {
        rows = rows.slice(0, stage.$limit);
      } else {
        throw new Error(`Unsupported aggregate stage: ${Object.keys(stage).join(',')}`);
      }
    }
    return { toArray: async () => rows as R[] };
  }

  // --- indexes -------------------------------------------------------------

  async createIndex(spec: Record<string, 1 | -1>, options: IndexOptions = {}): Promise<string> {
    if (options.expireAfterSeconds != null) return 'ttl-noop'; // handled by the sweep
    const fields = Object.keys(spec);
    for (const f of fields) {
      if (this.gcols.has(f)) continue;
      try {
        this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN "${f}" TEXT GENERATED ALWAYS AS (json_extract(doc, '$.${f}')) VIRTUAL`);
      } catch {
        // column already exists (created by a prior run)
      }
      this.gcols.add(f);
    }
    const name = `idx_${this.table}_${fields.join('_')}`;
    const cols = fields.map((f) => `"${f}"`).join(',');
    this.db.exec(`CREATE ${options.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON ${this.table}(${cols})`);
    return name;
  }

  // Re-register generated columns discovered on an existing table so prefilters
  // can use them before createIndex re-runs (used at open time).
  registerColumn(field: string): void {
    this.gcols.add(field);
  }
}

function groupStage(rows: Doc[], group: Record<string, any>): Doc[] {
  const idExpr = group._id as string; // '$field'
  const field = typeof idExpr === 'string' && idExpr.startsWith('$') ? idExpr.slice(1) : null;
  const accs = Object.entries(group).filter(([k]) => k !== '_id');
  const buckets = new Map<string, Doc>();
  for (const doc of rows) {
    const keyVal = field ? doc[field] : idExpr;
    const bk = String(norm(keyVal));
    let out = buckets.get(bk);
    if (!out) {
      out = { _id: keyVal };
      for (const [name] of accs) out[name] = undefined;
      buckets.set(bk, out);
    }
    for (const [name, spec] of accs) {
      if (spec.$sum != null) {
        const add = spec.$sum === 1 ? 1 : (doc[String(spec.$sum).slice(1)] as number) || 0;
        out[name] = ((out[name] as number) || 0) + add;
      } else if (spec.$max != null) {
        const v = doc[String(spec.$max).slice(1)];
        if (v != null && (out[name] == null || (v as any) > (out[name] as any))) out[name] = v;
      } else {
        throw new Error(`Unsupported group accumulator: ${Object.keys(spec).join(',')}`);
      }
    }
  }
  return [...buckets.values()];
}

// --- backend wiring ---------------------------------------------------------

// (collection name → table, id type). Sessions key on an opaque string id (the
// cookie value); everything else on an ObjectId.
const COLLECTIONS: { name: keyof Collections; table: string; idType: IdType }[] = [
  { name: 'users', table: 'users', idType: 'objectId' },
  { name: 'roles', table: 'roles', idType: 'objectId' },
  { name: 'apps', table: 'apps', idType: 'objectId' },
  { name: 'emailRules', table: 'email_allow_rules', idType: 'objectId' },
  { name: 'sessions', table: 'sessions', idType: 'string' },
  { name: 'audit', table: 'audit_logs', idType: 'objectId' },
  { name: 'usageDaily', table: 'usage_daily', idType: 'objectId' },
  { name: 'apiKeys', table: 'api_keys', idType: 'objectId' },
  { name: 'settings', table: 'settings', idType: 'objectId' },
];

export function openSqlite(filePath: string): StoreBackend {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = OFF');

  const collections = {} as Record<keyof Collections, SqliteCollection<any>>;
  for (const c of COLLECTIONS) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${c.table} (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
    collections[c.name] = new SqliteCollection(db, c.table, c.idType);
  }
  const col = collections as unknown as Collections;

  // Sweep expired sessions periodically (SQLite has no TTL index). Lazy expiry in
  // touchSession() is the correctness path; this just reclaims abandoned rows.
  const sweep = setInterval(() => {
    try {
      db.prepare(`DELETE FROM sessions WHERE json_extract(doc, '$.expires_at') < ?`).run(new Date().toISOString());
    } catch {
      /* table may not exist yet on first tick */
    }
  }, 60_000);
  (sweep as { unref?: () => void }).unref?.();

  return {
    col,
    ensureIndexes: async () => {
      /* index DDL is provided by the shared ensureIndexes() in db.ts via col.*.createIndex */
    },
    close: async () => {
      clearInterval(sweep);
      db.close();
    },
  };
}
