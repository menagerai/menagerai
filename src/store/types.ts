import { ObjectId } from 'mongodb';
import { ApiKey, AppDoc, AuditLog, EmailAllowRule, Role, SessionDoc, SettingsDoc, UsageDaily, User } from '../types';
import { Filter, UpdateDoc } from './mongoql';

// The narrow slice of the MongoDB collection API the app actually uses. Both the
// Mongo backend (a real driver Collection satisfies this at runtime) and the
// SQLite backend implement it, so `col.*` call sites are backend-agnostic.

export interface InsertOneResult {
  acknowledged: boolean;
  insertedId: ObjectId;
}
export interface UpdateResult {
  acknowledged: boolean;
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
  upsertedId: ObjectId | null;
}
export interface DeleteResult {
  acknowledged: boolean;
  deletedCount: number;
}

export interface FindCursor<T> {
  sort(spec: Record<string, 1 | -1>): FindCursor<T>;
  limit(n: number): FindCursor<T>;
  project(spec: Record<string, 0 | 1>): FindCursor<T>;
  toArray(): Promise<T[]>;
}
export interface AggCursor<R> {
  toArray(): Promise<R[]>;
}

export interface IndexOptions {
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
}

export interface ICollection<T> {
  findOne(filter?: Filter): Promise<T | null>;
  find(filter?: Filter, options?: { projection?: Record<string, 0 | 1> }): FindCursor<T>;
  insertOne(doc: any): Promise<InsertOneResult>;
  updateOne(filter: Filter, update: UpdateDoc, options?: { upsert?: boolean; arrayFilters?: Filter[] }): Promise<UpdateResult>;
  updateMany(filter: Filter, update: UpdateDoc, options?: { upsert?: boolean; arrayFilters?: Filter[] }): Promise<UpdateResult>;
  deleteOne(filter: Filter): Promise<DeleteResult>;
  deleteMany(filter: Filter): Promise<DeleteResult>;
  aggregate<R = any>(pipeline: any[]): AggCursor<R>;
  createIndex(spec: Record<string, 1 | -1>, options?: IndexOptions): Promise<string>;
}

export interface Collections {
  users: ICollection<User>;
  roles: ICollection<Role>;
  apps: ICollection<AppDoc>;
  emailRules: ICollection<EmailAllowRule>;
  sessions: ICollection<SessionDoc>;
  audit: ICollection<AuditLog>;
  usageDaily: ICollection<UsageDaily>;
  apiKeys: ICollection<ApiKey>;
  settings: ICollection<SettingsDoc>;
}

// A backend: the live collections plus lifecycle hooks.
export interface StoreBackend {
  col: Collections;
  ensureIndexes(): Promise<void>;
  close(): Promise<void>;
}
