"use client";
import * as React from "react";
import { Camera, CloudUpload, FileText, Trash2 } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useRecords } from "@/client/hooks";
import { vault } from "@/client/vault";
import { addReceipt, readPendingReceipt } from "@/client/receipts";
import { remove } from "@/client/actions";

export function ReceiptPicker({ transactionId, saved }: { transactionId: string; saved: boolean }) {
  const input = React.useRef<HTMLInputElement>(null);
  const attachments = useRecords("attachment").filter((a) => a.data.transactionId === transactionId);
  const pending = useLiveQuery(
    () => vault.store?.db.blobs.toArray().then((all) => all.filter((b) => b.transactionId === transactionId)) ?? [],
    [transactionId],
  );

  if (!saved) return <p className="text-xs text-muted-foreground">Save first, then open the transaction again to attach a receipt.</p>;

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !vault.store) return;
    try {
      await addReceipt(vault.store, vault.store!.dek, transactionId, file);
      toast.success("Receipt saved on this device. It uploads on the next sync.");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const openPending = async (id: string) => {
    const blob = await readPendingReceipt(vault.store!, vault.store!.dek, id);
    if (blob) window.open(URL.createObjectURL(blob), "_blank", "noopener");
  };

  return (
    <div className="grid gap-2">
      {attachments.map((a) => (
        <div key={a.id} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <a className="min-w-0 flex-1 truncate text-primary" href={`/api/receipts/${a.id}`} target="_blank" rel="noopener">
            {a.data.filename}
          </a>
          <Button size="icon-sm" variant="ghost" aria-label="Remove receipt" onClick={() => void remove("attachment", a.id)}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      {(pending ?? []).map((b) => (
        <div key={b.id} className="flex items-center gap-2 rounded-lg border border-dashed p-2 text-sm">
          <CloudUpload className="size-4 shrink-0 text-muted-foreground" />
          <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => void openPending(b.id)}>
            {b.filename}
          </button>
          <span className="text-xs text-muted-foreground">{b.status === "failed" ? b.lastError : "Waiting to upload"}</span>
        </div>
      ))}
      <input ref={input} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => void onPick(e)} />
      <Button type="button" variant="outline" onClick={() => input.current?.click()}>
        <Camera className="size-4" /> Attach receipt
      </Button>
      <p className="text-xs text-muted-foreground">Uploaded receipts open only while online.</p>
    </div>
  );
}
