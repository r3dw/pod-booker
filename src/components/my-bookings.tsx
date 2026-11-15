"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { btn, btnDanger } from "@/components/ui";
import { dayOf, formatDay, formatRange } from "@/lib/time";
import type { Kind, Profile, Space } from "@/lib/types";

type Mine = { id: string; space_id: number; starts_at: string; ends_at: string; kind: Kind; status: "active" | "cancelled" };

const OPEN_KEY = "pod-booker:my-bookings-open";
const PAST_DAYS = 90;

/**
 * The signed-in user's own bookings. Collapsed: one line with the next booking.
 * Expanded: Upcoming (with View/Cancel) and Past & cancelled (last 90 days, read-only).
 */
export function MyBookings({
  profile,
  spaces,
  supabase,
  ready,
  refreshKey,
  onView,
  onChanged,
}: {
  profile: Profile;
  spaces: Space[];
  supabase: SupabaseClient;
  ready: boolean;
  refreshKey: number;
  onView: (day: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"upcoming" | "past">("upcoming");
  const [upcoming, setUpcoming] = useState<Mine[] | null>(null);
  const [past, setPast] = useState<Mine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Restore open/closed from the last visit (client only).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading localStorage after mount
    if (localStorage.getItem(OPEN_KEY) === "1") setOpen(true);
  }, []);
  function toggle() {
    setOpen((o) => {
      localStorage.setItem(OPEN_KEY, o ? "0" : "1");
      return !o;
    });
  }

  const base = useCallback(
    // RLS already limits non-staff to their own rows; the filter matters for staff.
    () => supabase.from("bookings").select("id, space_id, starts_at, ends_at, kind, status").eq("booked_for", profile.id),
    [supabase, profile.id],
  );

  const loadUpcoming = useCallback(async () => {
    const { data, error } = await base().eq("status", "active").gt("ends_at", new Date().toISOString()).order("starts_at").limit(100);
    if (error) return setError(error.message);
    setUpcoming(data as Mine[]);
    setError(null);
  }, [base]);

  const loadPast = useCallback(async () => {
    const since = new Date(Date.now() - PAST_DAYS * 86_400_000).toISOString();
    const now = new Date().toISOString();
    // Ended bookings, plus cancelled ones (including cancelled future dates).
    const { data, error } = await base()
      .or(`ends_at.lte."${now}",status.eq.cancelled`)
      .gte("starts_at", since)
      .order("starts_at", { ascending: false })
      .limit(100);
    if (error) return setError(error.message);
    setPast(data as Mine[]);
    setError(null);
  }, [base]);

  useEffect(() => {
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetching external data
    loadUpcoming();
  }, [ready, loadUpcoming, refreshKey]);

  useEffect(() => {
    if (!ready || !open || tab !== "past") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetching external data
    loadPast();
  }, [ready, open, tab, loadPast, refreshKey]);

  const spaceName = (id: number) => spaces.find((s) => s.id === id)?.name ?? "?";
  const when = (b: Mine) => `${formatDay(dayOf(new Date(b.starts_at)))} · ${formatRange(b.starts_at, b.ends_at)}`;

  async function cancel(b: Mine) {
    if (!window.confirm(`Cancel your booking?\n${spaceName(b.space_id)}, ${when(b).replace(" · ", ", ")}`)) return;
    setBusyId(b.id);
    const { error } = await supabase.rpc("cancel_booking", { p_id: b.id });
    setBusyId(null);
    if (error) return setError(error.message);
    onChanged();
  }

  if (upcoming === null) return null;
  const next = upcoming[0];

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      {/* Header row: always visible, one line */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-controls="my-bookings-panel"
          className="flex items-center gap-1.5 font-semibold hover:underline"
        >
          <span aria-hidden className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>
            ▸
          </span>
          My bookings
        </button>
        {!open &&
          (next ? (
            <>
              <span className="text-zinc-600 dark:text-zinc-400">
                Next: <span className="font-medium text-zinc-900 dark:text-zinc-100">{spaceName(next.space_id)}</span>, {when(next)}
              </span>
              <button className="text-sm font-medium text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300" onClick={() => onView(dayOf(new Date(next.starts_at)))}>
                View
              </button>
              {upcoming.length > 1 && (
                <button className="text-zinc-500 hover:underline" onClick={toggle}>
                  +{upcoming.length - 1} more
                </button>
              )}
            </>
          ) : (
            <span className="text-zinc-500">No upcoming bookings</span>
          ))}
      </div>

      {open && (
        <div id="my-bookings-panel" className="border-t border-zinc-200 px-3 pb-3 pt-2 dark:border-zinc-800">
          <div role="tablist" className="mb-2 flex gap-1 text-sm">
            {(["upcoming", "past"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-md px-2.5 py-1 font-medium ${
                  tab === t ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                {t === "upcoming" ? `Upcoming (${upcoming.length})` : "Past & cancelled"}
              </button>
            ))}
          </div>

          {error && <p className="mb-2 text-sm text-red-700 dark:text-red-300">{error}</p>}

          {tab === "upcoming" ? (
            upcoming.length === 0 ? (
              <p className="py-1 text-sm text-zinc-500">No upcoming bookings. Click a free slot on the calendar to book.</p>
            ) : (
              <ul className="max-h-72 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800/70">
                {upcoming.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                    <span>
                      <span className="font-medium">{spaceName(b.space_id)}</span>
                      <span className="text-zinc-500">
                        {" "}
                        · {when(b)}
                        {b.kind === "walkin" && " · walk-in"}
                      </span>
                    </span>
                    <span className="flex gap-2">
                      <button className={btn} onClick={() => onView(dayOf(new Date(b.starts_at)))}>
                        View
                      </button>
                      <button className={btnDanger} disabled={busyId === b.id} onClick={() => cancel(b)}>
                        {busyId === b.id ? "Cancelling…" : "Cancel"}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : past === null ? (
            <p className="py-1 text-sm text-zinc-500">Loading…</p>
          ) : past.length === 0 ? (
            <p className="py-1 text-sm text-zinc-500">No past or cancelled bookings in the last {PAST_DAYS} days.</p>
          ) : (
            <ul className="max-h-72 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800/70">
              {past.map((b) => (
                <li key={b.id} className="py-1.5 text-sm">
                  <span className={b.status === "cancelled" ? "text-zinc-400 line-through" : "font-medium"}>{spaceName(b.space_id)}</span>
                  <span className="text-zinc-500">
                    {" "}
                    · {when(b)}
                    {b.kind === "walkin" && " · walk-in"}
                    {b.status === "cancelled" && " · cancelled"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
