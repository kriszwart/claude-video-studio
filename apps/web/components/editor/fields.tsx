"use client";
import { useEffect, useRef, useState } from "react";

/** Text field with local state; commits after a pause or on blur (autosave). */
export function DebouncedText({ value, onCommit, multiline = false, id, maxLength, placeholder, disabled, ariaLabel }: { value: string; onCommit: (v: string) => void; multiline?: boolean; id?: string; maxLength?: number; placeholder?: string; disabled?: boolean; ariaLabel?: string }) {
  const [v, setV] = useState(value);
  const dirty = useRef(false);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!dirty.current) setV(value);
  }, [value]);
  const commit = (next: string) => {
    clearTimeout(t.current);
    if (dirty.current && next !== value) onCommit(next);
    dirty.current = false;
  };
  const change = (next: string) => {
    dirty.current = true;
    setV(next);
    clearTimeout(t.current);
    t.current = setTimeout(() => commit(next), 700);
  };
  const common = { id, value: v, maxLength, placeholder, disabled, "aria-label": ariaLabel, className: `input ${multiline ? "min-h-16" : ""}`, onBlur: () => commit(v) };
  return multiline ? <textarea {...common} onChange={(e) => change(e.target.value)} /> : <input {...common} onChange={(e) => change(e.target.value)} />;
}

export function NumberField({ value, onCommit, step = 0.1, min, max, id, suffix, disabled }: { value: number; onCommit: (v: number) => void; step?: number; min?: number; max?: number; id?: string; suffix?: string; disabled?: boolean }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(Number(value.toFixed(2)))), [value]);
  const commit = () => {
    const n = Number(v);
    if (Number.isFinite(n) && n !== value) onCommit(min !== undefined ? Math.max(min, max !== undefined ? Math.min(max, n) : n) : n);
    else setV(String(value));
  };
  return (
    <div className="flex items-center gap-1">
      <input id={id} type="number" step={step} min={min} max={max} className="input w-24" value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      {suffix && <span className="text-xs text-faint">{suffix}</span>}
    </div>
  );
}

const TOKENS = ["brand.primary", "brand.secondary", "brand.accent", "brand.background", "brand.surface", "brand.text", "brand.muted"];

export function ColorField({ value, onChange, brandColors, id, allowUnset = false }: { value: string | undefined; onChange: (v: string | undefined) => void; brandColors: Record<string, string>; id?: string; allowUnset?: boolean }) {
  const isHex = value?.startsWith("#");
  return (
    <div className="flex items-center gap-2">
      <select id={id} className="input" value={isHex ? "custom" : (value ?? "")} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "custom" ? (brandColors.primary ?? "#ffffff") : e.target.value)}>
        {allowUnset && <option value="">Default</option>}
        {TOKENS.map((t) => (
          <option key={t} value={t}>{t.replace("brand.", "Brand ")}</option>
        ))}
        <option value="custom">Custom colour…</option>
      </select>
      <span className="h-6 w-6 shrink-0 rounded border border-line" style={{ background: value ? (isHex ? value : brandColors[value.replace("brand.", "")]) : "transparent" }} aria-hidden />
      {isHex && <input type="color" aria-label="Custom colour" value={value!.slice(0, 7)} onChange={(e) => onChange(e.target.value)} className="h-7 w-10 rounded border border-line bg-transparent" />}
    </div>
  );
}
