"use client";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/finance/primitives";
import type { Frequency, RecurrenceRule } from "@/lib/domain/types";
import { describeRule } from "@/lib/finance/recurrence";

type Preset = "once" | "daily" | "weekly" | "biweekly" | "monthly" | "yearly" | "custom";

function presetOf(r: RecurrenceRule): Preset {
  if (r.freq === "once") return "once";
  if (r.interval === 1) return r.freq;
  if (r.freq === "weekly" && r.interval === 2) return "biweekly";
  return "custom";
}

/** Repeat rule editor: presets plus custom "every N days/weeks/months/years" and an end. */
export function RuleEditor({ value, onChange, allowOnce = true }: { value: RecurrenceRule; onChange: (r: RecurrenceRule) => void; allowOnce?: boolean }) {
  const preset = presetOf(value);
  const ends: "never" | "date" | "count" = value.endDate ? "date" : value.count ? "count" : "never";
  const setPreset = (p: Preset) => {
    if (p === "custom") return onChange({ ...value, freq: value.freq === "once" ? "monthly" : value.freq, interval: Math.max(value.interval, 2) });
    if (p === "biweekly") return onChange({ ...value, freq: "weekly", interval: 2 });
    onChange({ ...value, freq: p as Frequency, interval: 1, ...(p === "once" ? { endDate: null, count: null } : {}) });
  };
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Repeats" htmlFor="rp">
          <NativeSelect id="rp" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            {allowOnce ? <option value="once">Does not repeat</option> : null}
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
            <option value="custom">Custom…</option>
          </NativeSelect>
        </Field>
        <Field label={value.freq === "once" ? "Date" : "Starts"} htmlFor="rs">
          <Input id="rs" type="date" value={value.startDate} onChange={(e) => e.target.value && onChange({ ...value, startDate: e.target.value })} />
        </Field>
      </div>
      {preset === "custom" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Every" htmlFor="ri">
            <Input id="ri" type="number" inputMode="numeric" min={1} max={366} value={value.interval} onChange={(e) => onChange({ ...value, interval: Math.max(1, Math.min(366, Number(e.target.value) || 1)) })} />
          </Field>
          <Field label="Unit" htmlFor="ru">
            <NativeSelect id="ru" value={value.freq} onChange={(e) => onChange({ ...value, freq: e.target.value as Frequency })}>
              <option value="daily">days</option>
              <option value="weekly">weeks</option>
              <option value="monthly">months</option>
              <option value="yearly">years</option>
            </NativeSelect>
          </Field>
        </div>
      ) : null}
      {value.freq !== "once" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Ends" htmlFor="re">
            <NativeSelect
              id="re"
              value={ends}
              onChange={(e) => {
                const v = e.target.value;
                onChange({ ...value, endDate: v === "date" ? value.endDate ?? value.startDate : null, count: v === "count" ? value.count ?? 12 : null });
              }}
            >
              <option value="never">Never</option>
              <option value="date">On a date</option>
              <option value="count">After…</option>
            </NativeSelect>
          </Field>
          {ends === "date" ? (
            <Field label="End date" htmlFor="red">
              <Input id="red" type="date" min={value.startDate} value={value.endDate ?? ""} onChange={(e) => onChange({ ...value, endDate: e.target.value || null })} />
            </Field>
          ) : ends === "count" ? (
            <Field label="Occurrences" htmlFor="rc">
              <Input id="rc" type="number" inputMode="numeric" min={1} value={value.count ?? 1} onChange={(e) => onChange({ ...value, count: Math.max(1, Number(e.target.value) || 1) })} />
            </Field>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">{describeRule(value)}</p>
    </div>
  );
}
