"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { formatPHP, parseAmount, toDecimalString, type Centavos } from "@/lib/finance/money";
import { Label } from "@/components/ui/label";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

/** Formatted PHP amount. Tone colours income/expense; amounts use tabular figures. */
export function Money({
  value,
  tone = "neutral",
  sign = "auto",
  className,
}: {
  value: Centavos;
  tone?: "neutral" | "auto" | "income" | "expense" | "muted";
  sign?: "auto" | "always" | "never";
  className?: string;
}) {
  const color =
    tone === "income" || (tone === "auto" && value > 0)
      ? "text-income"
      : tone === "expense" || (tone === "auto" && value < 0)
        ? "text-expense"
        : tone === "muted"
          ? "text-muted-foreground"
          : "";
  return <span className={cn("tabular whitespace-nowrap", color, className)}>{formatPHP(value, { sign })}</span>;
}

/**
 * Amount entry: decimal keypad, string state (no float maths), parsed to centavos on change.
 */
export function AmountInput({
  value,
  onChange,
  allowNegative,
  autoFocus,
  id,
  large,
  "aria-invalid": invalid,
}: {
  value: Centavos | null;
  onChange: (v: Centavos | null) => void;
  allowNegative?: boolean;
  autoFocus?: boolean;
  id?: string;
  large?: boolean;
  "aria-invalid"?: boolean;
}) {
  const [text, setText] = React.useState(value === null ? "" : toDecimalString(value));
  const last = React.useRef(value);
  React.useEffect(() => {
    if (value !== last.current) {
      setText(value === null ? "" : toDecimalString(value));
      last.current = value;
    }
  }, [value]);
  return (
    <div className="relative">
      <span className={cn("pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground", large && "text-2xl")}>₱</span>
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        enterKeyHint="done"
        placeholder="0.00"
        autoFocus={autoFocus}
        aria-invalid={invalid}
        className={cn(
          "tabular w-full rounded-lg border border-input bg-transparent pl-8 pr-3 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30",
          large ? "h-16 pl-10 text-3xl font-semibold" : "h-11 text-base",
        )}
        value={text}
        onChange={(e) => {
          const t = e.target.value;
          if (!/^[-+]?[\d,]*\.?\d{0,2}$/.test(t.replace(/\s/g, ""))) return;
          setText(t);
          const v = t.trim() === "" ? null : parseAmount(t, { allowNegative });
          last.current = v;
          onChange(v);
        }}
      />
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-sm text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Native select: uses the phone's own picker. */
export function NativeSelect({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-11 w-full appearance-none rounded-lg border border-input bg-transparent bg-[length:16px] bg-[right_0.75rem_center] bg-no-repeat px-3 pr-9 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23888%22 stroke-width=%222%22><path d=%22m6 9 6 6 6-6%22/></svg>')]",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

/** Segmented control for short option lists. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("flex gap-1 overflow-x-auto rounded-xl bg-muted p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "press min-h-9 flex-1 whitespace-nowrap rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors",
            value === o.value && "bg-background text-foreground shadow-sm",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Bottom sheet used for every form. Content scrolls; footer stays above the home indicator. */
export function FormSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent className="mx-auto max-h-[92dvh] max-w-lg">
        <DrawerHeader className="text-left">
          <DrawerTitle>{title}</DrawerTitle>
          {description ? <DrawerDescription>{description}</DrawerDescription> : null}
        </DrawerHeader>
        <div className="grid gap-4 overflow-y-auto overscroll-contain px-4 pb-2">{children}</div>
        {footer ? <DrawerFooter className="pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">{footer}</DrawerFooter> : null}
      </DrawerContent>
    </Drawer>
  );
}

export function EmptyState({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-10 text-center">
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <p className="font-medium">{title}</p>
      {children ? <div className="text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-1">
      <h2 className="text-sm font-semibold text-muted-foreground">{children}</h2>
      {action}
    </div>
  );
}

export function ColorDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return <span className={cn("inline-block size-2.5 shrink-0 rounded-full", className)} style={{ background: color ?? "var(--muted-foreground)" }} />;
}
