"use client";
import * as React from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EntityIcon, ICONS, PALETTE } from "@/components/finance/icons";
import { Field, FormSheet, SectionTitle, Segmented } from "@/components/finance/primitives";
import { ActionError, newId, remove, saveCategory, saveTag } from "@/client/actions";
import { useFinance } from "@/client/hooks";
import type { Category, CategoryKind, Tag } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export default function CategoriesPage() {
  const f = useFinance();
  const [kind, setKind] = React.useState<CategoryKind>("expense");
  const [edit, setEdit] = React.useState<{ open: boolean; c?: Category; key: number }>({ open: false, key: 0 });
  const [tagEdit, setTagEdit] = React.useState<{ open: boolean; t?: Tag; key: number }>({ open: false, key: 0 });
  const cats = f.categories.filter((c) => !c.deletedAt && c.kind === kind).sort((a, b) => Number(a.isArchived) - Number(b.isArchived) || a.name.localeCompare(b.name));
  return (
    <>
      <PageHeader title="Categories & tags" back="/app/more" action={<Button size="icon" variant="outline" aria-label="New category" onClick={() => setEdit((s) => ({ open: true, c: undefined, key: s.key + 1 }))}><Plus className="size-4" /></Button>} />
      <Segmented value={kind} onChange={setKind} options={[{ value: "expense", label: "Expense" }, { value: "income", label: "Income" }]} className="mb-3" />
      <div className="grid gap-1">
        {cats.map((c) => (
          <button key={c.id} type="button" onClick={() => setEdit((s) => ({ open: true, c, key: s.key + 1 }))} className={cn("press flex items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-muted/60", c.isArchived && "opacity-50")}>
            <EntityIcon name={c.icon} color={c.color} />
            <span className="flex-1 font-medium">{c.name}</span>
            {c.isArchived ? <span className="text-xs text-muted-foreground">archived</span> : null}
          </button>
        ))}
      </div>
      <section className="mt-6 grid gap-2">
        <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setTagEdit((s) => ({ open: true, t: undefined, key: s.key + 1 }))}><Plus className="size-3.5" /> Tag</Button>}>Tags</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {f.tags.length ? f.tags.map((t) => (
            <button key={t.id} type="button" onClick={() => setTagEdit((s) => ({ open: true, t, key: s.key + 1 }))} className="press rounded-full border px-3 py-1 text-sm">#{t.name}</button>
          )) : <p className="text-sm text-muted-foreground">No tags yet. Add them while entering transactions.</p>}
        </div>
      </section>
      <CategorySheet key={edit.key} open={edit.open} onOpenChange={(o) => setEdit((s) => ({ ...s, open: o }))} category={edit.c} kind={kind} />
      <TagSheet key={`t${tagEdit.key}`} open={tagEdit.open} onOpenChange={(o) => setTagEdit((s) => ({ ...s, open: o }))} tag={tagEdit.t} />
    </>
  );
}

function CategorySheet({ open, onOpenChange, category, kind }: { open: boolean; onOpenChange: (o: boolean) => void; category?: Category; kind: CategoryKind }) {
  const [name, setName] = React.useState(category?.name ?? "");
  const [icon, setIcon] = React.useState(category?.icon ?? "circle-ellipsis");
  const [color, setColor] = React.useState(category?.color ?? PALETTE[0]!);
  const [archived, setArchived] = React.useState(category?.isArchived ?? false);
  const [essential, setEssential] = React.useState(category?.isEssential ?? false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return setError("Name is required.");
    try {
      await saveCategory({ id: category?.id ?? newId(), name: name.trim(), kind: category?.kind ?? kind, icon, color, isArchived: archived, isEssential: essential });
      toast.success("Saved");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={category ? "Edit category" : `New ${kind} category`} footer={
      <div className="grid gap-2">
        <Button size="lg" onClick={() => void submit()}>Save</Button>
        {category ? <Button variant="destructive" onClick={() => void remove("category", category.id).then(() => onOpenChange(false)).catch((e) => setError(e.message))}>Delete</Button> : null}
      </div>
    }>
      <Field label="Name" htmlFor="cn"><Input id="cn" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Icon">
        <div className="flex flex-wrap gap-2">
          {Object.keys(ICONS).map((k) => (
            <button key={k} type="button" aria-label={k} onClick={() => setIcon(k)} className={cn("press rounded-xl", icon === k && "ring-2 ring-primary")}>
              <EntityIcon name={k} color={color} />
            </button>
          ))}
        </div>
      </Field>
      <Field label="Color">
        <div className="flex flex-wrap gap-2">
          {PALETTE.map((c) => <button key={c} type="button" aria-label={c} onClick={() => setColor(c)} className={cn("press size-8 rounded-full ring-offset-2 ring-offset-background", color === c && "ring-2 ring-foreground")} style={{ background: c }} />)}
        </div>
      </Field>
      {(category?.kind ?? kind) === "expense" ? (
        <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
          <span className="grid"><span className="font-medium">Essential expense</span><span className="text-xs text-muted-foreground">Used to estimate how long your emergency fund would last.</span></span>
          <Switch checked={essential} onCheckedChange={setEssential} />
        </label>
      ) : null}
      {category ? <label className="flex items-center justify-between rounded-xl border p-3 text-sm">Archived (hidden for new transactions) <Switch checked={archived} onCheckedChange={setArchived} /></label> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}

function TagSheet({ open, onOpenChange, tag }: { open: boolean; onOpenChange: (o: boolean) => void; tag?: Tag }) {
  const [name, setName] = React.useState(tag?.name ?? "");
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={tag ? "Edit tag" : "New tag"} footer={
      <div className="grid gap-2">
        <Button size="lg" onClick={() => name.trim() && void saveTag({ id: tag?.id ?? newId(), name: name.trim() }).then(() => onOpenChange(false))}>Save</Button>
        {tag ? <Button variant="destructive" onClick={() => void remove("tag", tag.id).then(() => onOpenChange(false))}>Delete tag</Button> : null}
      </div>
    }>
      <Field label="Name" htmlFor="tn"><Input id="tn" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></Field>
    </FormSheet>
  );
}
