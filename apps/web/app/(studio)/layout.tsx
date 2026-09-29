import { redirect } from "next/navigation";
import { authMode, getSession, needsSetup } from "@/lib/server/auth";
import { Nav } from "@/components/Nav";

export const dynamic = "force-dynamic";

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  if (await needsSetup()) redirect("/setup");
  let session;
  try {
    session = await getSession();
  } catch (e) {
    return (
      <main className="mx-auto max-w-lg p-8">
        <h1 className="mb-2 text-lg font-semibold">Access restricted</h1>
        <p className="text-dim">{e instanceof Error ? e.message : "This studio is not available from here."}</p>
      </main>
    );
  }
  if (!session) redirect("/login");
  return (
    <div className="flex min-h-screen flex-col">
      <Nav email={session.email} mode={authMode()} />
      <div className="flex-1">{children}</div>
    </div>
  );
}
