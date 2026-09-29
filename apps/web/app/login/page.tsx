"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/client/api";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <main className="mx-auto mt-24 max-w-sm p-6">
      <h1 className="mb-6 text-xl font-semibold">Sign in to Video Studio</h1>
      <form
        className="card space-y-4 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            await api("/api/auth/login", { method: "POST", json: { email, password } });
            location.href = "/projects";
          } catch (e) {
            setErr(e instanceof ApiError ? e.message : "Sign-in failed.");
          }
        }}
      >
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="pw">Password</label>
          <input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {err && <p role="alert" className="text-sm text-bad">{err}</p>}
        <button className="btn btn-primary w-full">Sign in</button>
      </form>
    </main>
  );
}
