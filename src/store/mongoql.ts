import { ObjectId } from 'mongodb';

// A tiny, dependency-light interpreter for the SUBSET of the MongoDB query and
// update language this app actually uses (see the grep inventory in db.ts). It
// operates on plain JS documents (parsed from the SQLite `doc` JSON column) so
// the SQLite backend can present the same collection semantics the Mongo backend
// does. Only the operators in use are implemented — deliberately not a general
// Mongo emulator.

export type Doc = Record<string, any>;
export type Filter = Record<string, any>;
export type UpdateDoc = Record<string, any>;

// --- value helpers ---------------------------------------------------------

function isObjectId(v: unknown): v is ObjectId {
  return Boolean(v) && (v instanceof ObjectId || (typeof v === 'object' && (v as any)._bsontype === 'ObjectId'));
}

// Normalize a value for comparison: ObjectIds compare by hex, Dates by epoch ms.
// This lets an ObjectId filter match a doc whose id was rehydrated as a hex
// string (the SQLite backend stores ids as text), and vice-versa.
export function norm(v: unknown): unknown {
  if (isObjectId(v)) return v.toHexString();
  if (v instanceof Date) return v.getTime();
  return v;
}

function eq(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b);
}

// Ordered comparison for range operators ($gt/$gte/$lt/$lte). When either side is
// a Date, compare by epoch (parsing a date-string counterpart) so timestamp queries
// work; otherwise compare naturally (so 'YYYY-MM-DD' day strings still order).
function cmp(v: unknown, operand: unknown): number {
  if (v instanceof Date || operand instanceof Date) {
    const a = v instanceof Date ? v.getTime() : Date.parse(String(v));
    const b = operand instanceof Date ? operand.getTime() : Date.parse(String(operand));
    return a - b;
  }
  if ((v as never) < (operand as never)) return -1;
  if ((v as never) > (operand as never)) return 1;
  return 0;
}

// True only for `{ $op: ... }` operator maps — NOT for ObjectId/Date/array/plain
// value objects, which are equality operands.
function isOperatorObject(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v) || isObjectId(v) || v instanceof Date) return false;
  const keys = Object.keys(v as object);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}

// Resolve a dotted path to the list of leaf values, expanding arrays along the
// way (so `grants.app` yields every grant's app). Used for match semantics where
// an equality against an array/array-of-subdocs matches if ANY element matches.
function resolveValues(doc: Doc, path: string): unknown[] {
  let cur: unknown[] = [doc];
  for (const part of path.split('.')) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (c == null) continue;
      if (Array.isArray(c)) {
        for (const el of c) if (el && typeof el === 'object' && part in el) next.push((el as Doc)[part]);
      } else if (typeof c === 'object' && part in (c as object)) {
        next.push((c as Doc)[part]);
      }
    }
    cur = next;
  }
  return cur;
}

function matchField(doc: Doc, key: string, cond: unknown): boolean {
  const values = resolveValues(doc, key);
  // Flatten one level so `{ roles: 'x' }` (roles is an array) matches on membership.
  const flat: unknown[] = [];
  for (const v of values) (Array.isArray(v) ? flat.push(...v) : flat.push(v));

  if (isOperatorObject(cond)) {
    return Object.entries(cond as Record<string, unknown>).every(([op, operand]) => {
      switch (op) {
        case '$in':
          return (operand as unknown[]).some((o) => flat.some((v) => eq(v, o)));
        case '$nin':
          return !(operand as unknown[]).some((o) => flat.some((v) => eq(v, o)));
        case '$gte':
          return flat.some((v) => v != null && cmp(v, operand) >= 0);
        case '$gt':
          return flat.some((v) => v != null && cmp(v, operand) > 0);
        case '$lte':
          return flat.some((v) => v != null && cmp(v, operand) <= 0);
        case '$lt':
          return flat.some((v) => v != null && cmp(v, operand) < 0);
        case '$ne':
          return !flat.some((v) => eq(v, operand));
        case '$exists':
          return operand ? flat.length > 0 : flat.length === 0;
        default:
          throw new Error(`Unsupported query operator: ${op}`);
      }
    });
  }
  if (cond === null) return flat.length === 0 || flat.some((v) => v == null);
  return flat.some((v) => eq(v, cond));
}

export function matches(doc: Doc, filter: Filter): boolean {
  return Object.entries(filter).every(([key, cond]) => matchField(doc, key, cond));
}

// --- update application -----------------------------------------------------

function setPlainPath(target: Doc, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Doc = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

// Apply one `$set` entry, handling positional (`field.$`) and arrayFilters
// (`field.$[id].sub`) forms in addition to plain dotted paths.
function applySet(doc: Doc, key: string, value: unknown, filter: Filter, arrayFilters: Filter[]): void {
  const posIdx = key.indexOf('.$');
  if (posIdx === -1) {
    setPlainPath(doc, key, value);
    return;
  }
  const field = key.slice(0, posIdx);
  const rest = key.slice(posIdx + 2); // after ".$"
  const arr = doc[field];
  if (!Array.isArray(arr)) return;

  if (rest.startsWith('[')) {
    // arrayFilters form: field.$[id].sub — set `sub` on every element the
    // identifier's condition matches (e.g. `grants.$[g].app` with `{ 'g.app': x }`).
    const close = rest.indexOf(']');
    const id = rest.slice(1, close);
    const sub = rest.slice(close + 2); // after "]."
    const af = arrayFilters.find((f) => Object.keys(f).some((k) => k.startsWith(`${id}.`)));
    const cond: Filter = {};
    if (af) for (const [k, v] of Object.entries(af)) if (k.startsWith(`${id}.`)) cond[k.slice(id.length + 1)] = v;
    for (const el of arr) if (el && typeof el === 'object' && matches(el, cond)) setPlainPath(el, sub, value);
  } else {
    // positional `$` (whole element): replace elements equal to the value the
    // query matched on `field` (e.g. `roles.$` with a `{ roles: x }` query).
    const target = filter[field];
    for (let i = 0; i < arr.length; i++) if (eq(arr[i], target)) arr[i] = value;
  }
}

// A $pull condition is a sub-document match when it's a plain object (e.g.
// `{ app: x }`), otherwise an equality against the element value.
function pullMatch(el: unknown, cond: unknown): boolean {
  const isSubMatch = cond !== null && typeof cond === 'object' && !isObjectId(cond) && !(cond instanceof Date) && !Array.isArray(cond);
  if (isSubMatch) return el != null && typeof el === 'object' && matches(el as Doc, cond as Filter);
  return eq(el, cond);
}

// Apply an update document to `doc` IN PLACE. Returns whether anything changed.
export function applyUpdate(doc: Doc, update: UpdateDoc, filter: Filter = {}, arrayFilters: Filter[] = []): void {
  for (const [op, payload] of Object.entries(update)) {
    switch (op) {
      case '$set':
        for (const [k, v] of Object.entries(payload as Doc)) applySet(doc, k, v, filter, arrayFilters);
        break;
      case '$setOnInsert':
        break; // handled only on insert (see upsert path)
      case '$push':
        for (const [k, v] of Object.entries(payload as Doc)) {
          if (!Array.isArray(doc[k])) doc[k] = [];
          doc[k].push(v);
        }
        break;
      case '$addToSet':
        for (const [k, v] of Object.entries(payload as Doc)) {
          if (!Array.isArray(doc[k])) doc[k] = [];
          if (!doc[k].some((e: unknown) => eq(e, v))) doc[k].push(v);
        }
        break;
      case '$pull':
        for (const [k, cond] of Object.entries(payload as Doc)) {
          if (Array.isArray(doc[k])) doc[k] = doc[k].filter((el: unknown) => !pullMatch(el, cond));
        }
        break;
      case '$inc':
        for (const [k, v] of Object.entries(payload as Doc)) doc[k] = (doc[k] || 0) + (v as number);
        break;
      default:
        throw new Error(`Unsupported update operator: ${op}`);
    }
  }
}

// Build a fresh document for an upsert that matched nothing: the filter's
// equality fields, then $setOnInsert, then the non-$setOnInsert update ops.
export function buildUpsertDoc(filter: Filter, update: UpdateDoc): Doc {
  const doc: Doc = {};
  for (const [k, v] of Object.entries(filter)) if (!k.includes('.') && !isOperatorObject(v)) doc[k] = v;
  if (update.$setOnInsert) for (const [k, v] of Object.entries(update.$setOnInsert as Doc)) setPlainPath(doc, k, v);
  applyUpdate(doc, update, filter);
  return doc;
}

// --- projection & sort ------------------------------------------------------

export function projectDoc(doc: Doc, projection?: Record<string, 0 | 1>): Doc {
  if (!projection) return doc;
  const keys = Object.keys(projection);
  if (keys.length === 0) return doc;
  const including = projection[keys.find((k) => k !== '_id') ?? keys[0]] === 1;
  const out: Doc = {};
  if (including) {
    for (const k of keys) if (projection[k] === 1) out[k] = doc[k];
    if (projection._id !== 0) out._id = doc._id;
  } else {
    Object.assign(out, doc);
    for (const k of keys) if (projection[k] === 0) delete out[k];
  }
  return out;
}

export function sortDocs<T extends Doc>(rows: T[], spec: Record<string, 1 | -1>): T[] {
  const keys = Object.entries(spec);
  return rows.slice().sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = norm((a as Doc)[k]);
      const bv = norm((b as Doc)[k]);
      if (av === bv) continue;
      if (av == null) return -dir as number;
      if (bv == null) return dir as number;
      return (av > bv ? 1 : -1) * dir;
    }
    return 0;
  });
}
