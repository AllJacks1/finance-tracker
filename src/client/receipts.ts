"use client";
/**
 * Receipts: images are compressed on the device, stored ENCRYPTED in IndexedDB, and uploaded by
 * the sync engine (same Wi-Fi rules) once their transaction exists on the server.
 */
import type { Attachment } from "@/lib/domain/types";
import type { ServerRecord } from "@/lib/sync/protocol";
import { ApiCallError } from "./api";
import { decryptBytes, encryptBytes, sha256Hex } from "./crypto";
import type { PendingBlob } from "./local-db";
import type { WorkspaceStore } from "./store";

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
export const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

/** Downscale photos to max 1600px JPEG to keep uploads small on mobile. */
export async function compressImage(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap === "undefined") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.8));
    return out && out.size < file.size ? out : file;
  } catch {
    return file;
  }
}

export type ReceiptOwner = { transactionId: string } | { billId: string };

export async function addReceipt(store: WorkspaceStore, dek: CryptoKey, owner: ReceiptOwner, file: File) {
  const blob = await compressImage(file);
  const mime = blob.type || file.type;
  if (!RECEIPT_TYPES.includes(mime)) throw new Error("Use a photo (JPEG, PNG, WebP) or a PDF.");
  if (blob.size > MAX_RECEIPT_BYTES) throw new Error("Receipt is larger than 5 MB.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const enc = await encryptBytes(dek, bytes);
  const entry: PendingBlob = {
    id: crypto.randomUUID(),
    transactionId: "transactionId" in owner ? owner.transactionId : "",
    billId: "billId" in owner ? owner.billId : undefined,
    filename: (file.name || "receipt").slice(0, 200).replace(/\.[^.]+$/, mime === "application/pdf" ? ".pdf" : ".jpg"),
    mime,
    sizeBytes: bytes.length,
    sha256,
    status: "pending",
    lastError: null,
    ...enc,
  };
  await store.db.blobs.put(entry);
  store.notify();
  store.onLocalChange?.();
  return entry;
}

export async function readPendingReceipt(store: WorkspaceStore, dek: CryptoKey, id: string): Promise<Blob | null> {
  const b = await store.db.blobs.get(id);
  if (!b) return null;
  return new Blob([(await decryptBytes(dek, b)) as Uint8Array<ArrayBuffer>], { type: b.mime });
}

/** Upload pending receipts whose transaction is already on the server. */
export async function uploadPendingReceipts(store: WorkspaceStore, dek: CryptoKey, fetcher: (path: string, init: RequestInit) => Promise<Response>) {
  const pending = await store.db.blobs.where("status").equals("pending").toArray();
  for (const b of pending) {
    // Upload only once the owner (transaction or bill) exists on the server.
    const owner = b.billId ? store.get("bill", b.billId) : store.get("transaction", b.transactionId);
    if (!owner || owner.version === 0) continue;
    const bytes = await decryptBytes(dek, b);
    const qs = new URLSearchParams({ id: b.id, filename: b.filename, sha256: b.sha256, ...(b.billId ? { billId: b.billId } : { transactionId: b.transactionId }) });
    let res: Response;
    try {
      res = await fetcher(`/api/receipts?${qs}`, {
        method: "POST",
        headers: { "content-type": b.mime },
        body: bytes as Uint8Array<ArrayBuffer>,
        credentials: "same-origin",
      });
    } catch {
      throw new ApiCallError(0, "network", "Can't reach the server.");
    }
    if (res.status === 401) throw new ApiCallError(401, "unauthorized", "Sign in");
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      await store.db.blobs.update(b.id, { status: "failed", lastError: err?.error?.message ?? `Upload failed (${res.status})` });
      continue;
    }
    const { record } = (await res.json()) as { record: ServerRecord };
    await store.applyServerRecord(record, { force: true });
    await store.db.blobs.delete(b.id);
  }
}

export type { Attachment };
