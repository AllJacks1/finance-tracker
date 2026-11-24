/**
 * IndexedDB layout (Dexie).
 *
 * `ft_device` (shared, contains NO financial data): this browser's install id and the list of
 * users who have local data here (for the lock screen).
 *
 * `ft_u_<hash(userId)>` (one database per user): every financial value is encrypted with that
 * user's DEK. Only ids, versions and queue bookkeeping are stored in plaintext.
 */
import Dexie, { type Table } from "dexie";
import type { EntityName } from "@/lib/domain/types";
import type { OpKind } from "@/lib/sync/protocol";
import type { PinWrap, Wrapped } from "./crypto";

export interface KnownUser {
  userId: string;
  name: string;
  dbName: string;
  lastUsedAt: string;
}

export class DeviceDB extends Dexie {
  kv!: Table<{ key: string; value: unknown }, string>;
  users!: Table<KnownUser, string>;
  constructor() {
    super("ft_device");
    this.version(1).stores({ kv: "key", users: "userId" });
    this.version(2).stores({ kv: "key", users: "userId, lastUsedAt" });
  }
}

/** Stored record: plaintext keys + encrypted payload. */
export interface StoredRecord extends Wrapped {
  entity: EntityName;
  id: string;
  /** Last version confirmed by the server (0 = never synced). */
  version: number;
}

/** Encrypted payload of a StoredRecord. */
export interface RecordPayload {
  data: Record<string, unknown>;
  deletedAt: string | null;
  changeSeq: number;
  updatedAt: string | null;
}

export type OutboxStatus = "pending" | "inflight" | "failed" | "conflict";

export interface OutboxEntry extends Wrapped {
  seq?: number;
  opId: string;
  entity: EntityName;
  entityId: string;
  kind: OpKind;
  baseVersion: number | null;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: string;
}

export interface ConflictEntry extends Wrapped {
  entityId: string;
  entity: EntityName;
  opId: string;
  createdAt: string;
}

export interface PendingBlob extends Wrapped {
  id: string; // attachment id
  transactionId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  status: "pending" | "failed";
  lastError: string | null;
}

export interface KeyWraps {
  recovery: Wrapped;
  pin: PinWrap | null;
}

export class UserDB extends Dexie {
  records!: Table<StoredRecord, [EntityName, string]>;
  outbox!: Table<OutboxEntry, number>;
  conflicts!: Table<ConflictEntry, string>;
  blobs!: Table<PendingBlob, string>;
  meta!: Table<{ key: string; value: unknown }, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records: "[entity+id], entity",
      outbox: "++seq, &opId, entityId, status",
      conflicts: "entityId",
      blobs: "id, status",
      meta: "key",
    });
  }
}

let deviceDb: DeviceDB | null = null;
export function getDeviceDb(): DeviceDB {
  deviceDb ??= new DeviceDB();
  return deviceDb;
}

export async function getInstallId(): Promise<string> {
  const db = getDeviceDb();
  const row = await db.kv.get("installId");
  if (row) return row.value as string;
  const id = crypto.randomUUID();
  await db.kv.put({ key: "installId", value: id });
  return id;
}

export async function userDbName(userId: string): Promise<string> {
  const { sha256Hex } = await import("./crypto");
  return `ft_u_${(await sha256Hex(`ft:${userId}`)).slice(0, 24)}`;
}

export async function deleteUserDb(userId: string) {
  const name = await userDbName(userId);
  await Dexie.delete(name);
  await getDeviceDb().users.delete(userId);
}
