import { Suspense } from "react";
import { SignOutButton, UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import DayView from "@/components/day-view";
import { createServerSupabase } from "@/lib/supabase";
import type { Profile, Space } from "@/lib/types";
import { btn } from "@/components/ui";

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <main className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Pod Booker</h1>
        <UserButton />
      </header>
      <Suspense fallback={<p className="text-zinc-500">Loading calendar…</p>}>
        <Calendar searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Calendar({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  await auth.protect();
  const supabase = createServerSupabase();

  // Creates the profile on first sign-in; the database rejects non-uchicago emails.
  const { data: profile, error } = await supabase.rpc("ensure_profile");
  if (error || !profile) {
    return (
      <div className="max-w-lg space-y-3 rounded-lg border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
        <p className="font-medium">You can’t use Pod Booker with this account.</p>
        <p className="text-sm">{error?.message ?? "No profile was created."}</p>
        <SignOutButton>
          <button className={btn}>Sign out</button>
        </SignOutButton>
      </div>
    );
  }

  const { data: spaces } = await supabase
    .from("spaces")
    .select("id, name, kind, capacity, bookable_by")
    .eq("active", true)
    .order("id");

  const { day } = await searchParams;
  const initialDay = typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
  return <DayView profile={profile as Profile} spaces={(spaces ?? []) as Space[]} initialDay={initialDay} />;
}
