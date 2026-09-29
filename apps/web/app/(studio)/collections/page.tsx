"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError, fmtBytes, fmtDuration } from "@/lib/client/api";

interface C {
  id: string;
  name: string;
  files: number;
  bytes: number;
  indexed: number;
  durationSec: number;
  createdAt: string;
}

/** Event collections: recordings grouped independently of any one project (FR-16). */
export default function Collections() {
  const [rows, setRows] = useState<C[] | null>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = () => api<{ collections: C[] }>("/api/collections").then((r) => setRows(r.collections));
  useEffect(() => {
    void load();
  }, []);
  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="mb-1 text-xl font-semibold">Collections</h1>
      <p className="mb-4 text-sm text-dim">Group event recordings, index their transcripts, search for authentic moments and build a sizzle reel. Quotes always come from the recordings; nothing is generated.</p>
      <form
        className="mb-6 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            const r = await api<{ collection: { id: string } }>("/api/collections", { method: "POST", json: { name } });
            location.href = `/collections/${r.collection.id}`;
          } catch (x) {
            setErr(x instanceof ApiError ? x.message : String(x));
          }
        }}
      >
        <input className="input max-w-sm" placeholder="e.g. Harbor Summit 2026" aria-label="Collection name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        <button className="btn btn-primary" disabled={!name.trim()}>New collection</button>
      </form>
      {err && <p role="alert" className="mb-4 text-sm text-red-400">{err}</p>}
      {rows === null ? (
        <p className="text-dim">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-dim">No collections yet.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {rows.map((c) => (
            <li key={c.id} className="card p-4">
              <Link href={`/collections/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
              <p className="mt-1 text-xs text-dim">
                {c.files} files · {fmtBytes(c.bytes)} · {fmtDuration(c.durationSec)} of source · {c.indexed} indexed
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
