import { Suspense } from "react";
import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { createServerSupabase } from "@/lib/supabase";

// Day-1 check: prove Supabase accepts the Clerk token and RLS sees the Clerk user id.
// Replaced by the calendar on day 3.
export default function Home() {
  return (
    <main className="mx-auto w-full max-w-2xl p-8 font-sans">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Pod Booking</h1>
        <UserButton />
      </header>
      <Suspense fallback={<p>Checking…</p>}>
        <AuthCheck />
      </Suspense>
    </main>
  );
}

async function AuthCheck() {
  const { userId } = await auth();
  const supabase = createServerSupabase();

  const [{ data: who, error: whoError }, { data: spaces, error: spacesError }] =
    await Promise.all([
      supabase.rpc("whoami"),
      supabase.from("spaces").select("id, name, kind, capacity, bookable_by").order("id"),
    ]);

  const match = who?.sub === userId;

  return (
    <>
      <section className="mb-8 space-y-1">
        <h2 className="font-medium">Auth check</h2>
        <p>Clerk user id: <code>{userId}</code></p>
        <p>Supabase sees: <code>{who?.sub ?? "(nothing)"}</code> as role <code>{who?.role ?? "?"}</code></p>
        <p className={match ? "text-green-700" : "text-red-700"}>
          {match ? "✓ Match — RLS sees the Clerk user." : `✗ No match${whoError ? `: ${whoError.message}` : ""}`}
        </p>
      </section>

      <section>
        <h2 className="mb-2 font-medium">Spaces (read through RLS)</h2>
        {spacesError ? (
          <p className="text-red-700">{spacesError.message}</p>
        ) : spaces?.length ? (
          <ul className="list-disc pl-6">
            {spaces.map((s) => (
              <li key={s.id}>
                {s.name} — {s.kind}, capacity {s.capacity}, bookable by {s.bookable_by.join(", ")}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-red-700">No rows — token not accepted, or not seeded.</p>
        )}
      </section>
    </>
  );
}
