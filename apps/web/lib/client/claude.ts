"use client";
import { useEffect, useState } from "react";
import { api } from "./api";

export interface ClaudeStatus {
  readiness: { mode: "subscription" | "api" | "off"; available: boolean; message: string; recovery?: string; setupUrl: string };
  runtime: {
    mode: "subscription" | "api" | "off";
    explicit: boolean;
    subscriptionAllowed: boolean;
    lastCheck: { ok: boolean; state: string; observed: string; plan: string | null; message: string; recovery?: string; overrides: string[]; at: string } | null;
    lastLimit: { status: string; rateLimitType?: string; resetsAt?: string; utilization?: number; at: string } | null;
    apiKeyConfigured: boolean;
    apiKeySource: "settings" | "env" | null;
    overrides: string[];
  };
}

/** Claude runtime readiness for enabling/disabling AI actions. `null` while loading. */
export function useClaudeStatus(): [ClaudeStatus | null, (s: ClaudeStatus) => void] {
  const [s, set] = useState<ClaudeStatus | null>(null);
  useEffect(() => {
    api<ClaudeStatus>("/api/settings/claude").then(set).catch(() => {});
  }, []);
  return [s, set];
}
