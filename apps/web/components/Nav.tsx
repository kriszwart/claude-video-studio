"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/projects", label: "Projects" },
  { href: "/templates", label: "Templates" },
  { href: "/brand-kits", label: "Brand Kits" },
  { href: "/assets", label: "Assets" },
  { href: "/collections", label: "Collections" },
  { href: "/settings", label: "Settings" },
];

export function Nav({ email, mode }: { email: string; mode: "local" | "password" }) {
  const path = usePathname();
  if (/^\/projects\/[^/]+$/.test(path) && path !== "/projects/new") return null; // the editor has its own header
  return (
    <header className="border-b border-line bg-panel">
      <nav aria-label="Main" className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-4 py-2">
        <Link href="/projects" className="mr-4 shrink-0 font-semibold tracking-tight">
          Video Studio
        </Link>
        {ITEMS.map((i) => {
          const active = path.startsWith(i.href);
          return (
            <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined} className={`shrink-0 rounded-md px-2.5 py-1.5 text-sm ${active ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"}`}>
              {i.label}
            </Link>
          );
        })}
        <span className="ml-auto hidden shrink-0 text-xs text-faint sm:block">
          {mode === "local" ? "Local development mode (this machine only)" : email}
        </span>
        {mode === "password" && (
          <button
            className="btn btn-ghost ml-2 shrink-0 text-xs"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              location.href = "/login";
            }}
          >
            Sign out
          </button>
        )}
      </nav>
    </header>
  );
}
