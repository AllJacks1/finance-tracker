"use client";
import {
  Banknote,
  BriefcaseBusiness,
  Bus,
  CircleEllipsis,
  CirclePlus,
  Clapperboard,
  CreditCard,
  Gift,
  HandCoins,
  HeartPulse,
  Landmark,
  PiggyBank,
  Plug,
  Receipt,
  ShoppingBag,
  Smartphone,
  Store,
  Utensils,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { AccountType } from "@/lib/domain/types";

export const ICONS: Record<string, LucideIcon> = {
  utensils: Utensils,
  bus: Bus,
  plug: Plug,
  "shopping-bag": ShoppingBag,
  clapperboard: Clapperboard,
  "heart-pulse": HeartPulse,
  receipt: Receipt,
  "circle-ellipsis": CircleEllipsis,
  briefcase: BriefcaseBusiness,
  store: Store,
  gift: Gift,
  "circle-plus": CirclePlus,
  wallet: Wallet,
  landmark: Landmark,
  smartphone: Smartphone,
  "piggy-bank": PiggyBank,
  "credit-card": CreditCard,
  "hand-coins": HandCoins,
  banknote: Banknote,
};

export const ACCOUNT_TYPE_META: Record<AccountType, { label: string; icon: string }> = {
  cash: { label: "Cash", icon: "wallet" },
  bank: { label: "Bank account", icon: "landmark" },
  ewallet: { label: "E-wallet (GCash, Maya…)", icon: "smartphone" },
  savings: { label: "Savings", icon: "piggy-bank" },
  credit_card: { label: "Credit card", icon: "credit-card" },
  loan: { label: "Loan", icon: "hand-coins" },
  other: { label: "Other", icon: "banknote" },
};

export function EntityIcon({ name, fallback = "circle-ellipsis", className, color }: { name: string | null | undefined; fallback?: string; className?: string; color?: string | null }) {
  const Icon = ICONS[name ?? ""] ?? ICONS[fallback] ?? CircleEllipsis;
  return (
    <span
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl"
      style={{ background: color ? `color-mix(in oklch, ${color} 16%, transparent)` : "var(--muted)", color: color ?? undefined }}
    >
      <Icon className={className ?? "size-[18px]"} />
    </span>
  );
}

export const PALETTE = ["#0ea5e9", "#10b981", "#f97316", "#8b5cf6", "#ec4899", "#eab308", "#ef4444", "#64748b", "#14b8a6", "#6366f1"];
