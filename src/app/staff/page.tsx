import Link from "next/link";
import { Suspense } from "react";
import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import StaffTools from "@/components/staff-tools";
import { btn } from "@/components/ui";
import { createServerSupabase } from "@/lib/supabase";
import type { Profile, Space } from "@/lib/types";

export default function StaffPage({ searchParams }: PageProps<"/staff">) {
  return (
    <main className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/" className={btn}>
            ← Calendar
          </Link>
          <h1 className="text-xl font-semibold">Staff tools</h1>
        </div>
        <UserButton />
      </header>
      <Suspense fallback={<p className="text-zinc-500">Loading…</p>}>
        <Gate searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Gate({ searchParams }: { searchParams: PageProps<"/staff">["searchParams"] }) {
  await auth.protect();
  const supabase = createServerSupabase();
  const { data: profile } = await supabase.rpc("ensure_profile");
  // UI gate only; every staff action is also checked in the database.
  if ((profile as Profile | null)?.role !== "staff") {
    return <p className="text-zinc-600 dark:text-zinc-400">This page is for staff.</p>;
  }
  const { data: spaces } = await supabase
    .from("spaces")
    .select("id, name, kind, capacity, bookable_by")
    .eq("active", true)
    .order("id");
  const { tab } = await searchParams;
  return <StaffTools me={profile as Profile} spaces={(spaces ?? []) as Space[]} initialTab={typeof tab === "string" ? tab : undefined} />;
}
