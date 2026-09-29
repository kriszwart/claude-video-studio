"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/client/api";

export default function Setup() {
  const [f, setF] = useState({ email: "", password: "", setupToken: "" });
  const [err, setErr] = useState<string | null>(null);
  return (
    <main className="mx-auto mt-20 max-w-md p-6">
      <h1 className="mb-2 text-xl font-semibold">Create the owner account</h1>
      <p className="mb-6 text-sm text-dim">This installation has no owner yet. Enter the server's SETUP_TOKEN to claim it.</p>
      <form
        className="card space-y-4 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("/api/auth/setup", { method: "POST", json: f });
            location.href = "/projects";
          } catch (e) {
            setErr(e instanceof ApiError ? `${e.message}${e.recovery ? ` ${e.recovery}` : ""}` : "Setup failed.");
          }
        }}
      >
        {(["email", "password", "setupToken"] as const).map((k) => (
          <div key={k}>
            <label className="label" htmlFor={k}>{k === "setupToken" ? "Setup token" : k === "email" ? "Email" : "Password (10+ characters)"}</label>
            <input id={k} className="input" type={k === "email" ? "email" : "password"} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required />
          </div>
        ))}
        {err && <p role="alert" className="text-sm text-bad">{err}</p>}
        <button className="btn btn-primary w-full">Create owner</button>
      </form>
    </main>
  );
}
