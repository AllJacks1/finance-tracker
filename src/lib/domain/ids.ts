/**
 * Deterministic ids for records that represent "the same real-world thing" on every device:
 * a confirmed schedule occurrence, a bill instance, a card statement bill, a monthly snapshot,
 * an imported CSV row. Two devices acting offline produce the SAME id, so the server keeps one
 * record (identical data → "duplicate"; different data → visible conflict). Never random.
 */
import { v5 as uuidv5 } from "uuid";

const NAMESPACE = "b9d3a0c4-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

export const occurrenceTxnId = (scheduleId: string, date: string) => uuidv5(`txn:${scheduleId}:${date}`, NAMESPACE);
export const billOccurrenceId = (scheduleId: string, date: string) => uuidv5(`bill:${scheduleId}:${date}`, NAMESPACE);
export const scheduleExceptionId = (scheduleId: string, date: string) => uuidv5(`exc:${scheduleId}:${date}`, NAMESPACE);
export const cardStatementBillId = (cardAccountId: string, closingDate: string) =>
  uuidv5(`cardbill:${cardAccountId}:${closingDate}`, NAMESPACE);
export const monthlySnapshotId = (workspaceId: string, date: string) => uuidv5(`nw:${workspaceId}:${date}`, NAMESPACE);
export const importedTxnId = (accountId: string, fingerprint: string) => uuidv5(`imp:${accountId}:${fingerprint}`, NAMESPACE);
