"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useSupabase } from "@/lib/supabase-browser";
import {
  CLOSE,
  OPEN,
  STEP,
  addDays,
  chicagoTime,
  dayOf,
  firstOpenDay,
  formatClock,
  formatDay,
  isOpenDay,
  minutesOf,
  stepOpenDay,
  todayChicago,
} from "@/lib/time";
import type { Profile, Slot, Space } from "@/lib/types";
import { BookingPanel, type Selection } from "./booking-panel";
import { MyBookings } from "./my-bookings";
import { btn } from "@/components/ui";

const SLOT_H = 36; // px per 30 minutes
const ROWS = (CLOSE - OPEN) / STEP;

const STAFF_SELECT =
  "id, space_id, starts_at, ends_at, kind, title, booked_for, series_id, created_at," +
  " for_profile:profiles!bookings_booked_for_fkey(email, display_name)," +
  " by_profile:profiles!bookings_booked_by_fkey(email, display_name)";

export const KIND_STYLE: Record<Slot["kind"], { label: string; block: string; dot: string }> = {
  class: { label: "Class", block: "bg-indigo-100 border-indigo-400 text-indigo-950 dark:bg-indigo-950 dark:border-indigo-500 dark:text-indigo-100", dot: "bg-indigo-400" },
  recurring: { label: "Recurring session", block: "bg-violet-100 border-violet-400 text-violet-950 dark:bg-violet-950 dark:border-violet-500 dark:text-violet-100", dot: "bg-violet-400" },
  reservation: { label: "Reservation", block: "bg-sky-100 border-sky-400 text-sky-950 dark:bg-sky-950 dark:border-sky-500 dark:text-sky-100", dot: "bg-sky-400" },
  walkin: { label: "Walk-in", block: "bg-amber-100 border-amber-400 text-amber-950 dark:bg-amber-950 dark:border-amber-500 dark:text-amber-100", dot: "bg-amber-400" },
};

type StaffRow = Omit<Slot, "is_mine" | "booked_for" | "booked_by"> & {
  booked_for: string | null;
  for_profile: { email: string; display_name: string | null } | null;
  by_profile: { email: string; display_name: string | null } | null;
};

export default function DayView({ profile, spaces, initialDay }: { profile: Profile; spaces: Space[]; initialDay?: string }) {
  const { supabase, ready } = useSupabase();
  const isStaff = profile.role === "staff";

  const [day, setDay] = useState(() => initialDay ?? todayChicago());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadedDay, setLoadedDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshKey, setRefreshKey] = useState(0);

  // Re-render every 30 s so past slots and the "now" line stay current.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(
    async (forDay: string) => {
      const from = chicagoTime(forDay, 0).toISOString();
      const to = chicagoTime(addDays(forDay, 1), 0).toISOString();

      let rows: Slot[];
      if (isStaff) {
        const { data, error } = await supabase
          .from("bookings")
          .select(STAFF_SELECT)
          .eq("status", "active")
          .gte("starts_at", from)
          .lt("starts_at", to)
          .order("starts_at");
        if (error) return setError(error.message);
        rows = (data as unknown as StaffRow[]).map(({ for_profile, by_profile, booked_for, ...r }) => ({
          ...r,
          is_mine: booked_for === profile.id,
          booked_for: for_profile,
          booked_by: by_profile,
        }));
      } else {
        const { data, error } = await supabase
          .from("calendar_public")
          .select("id, space_id, starts_at, ends_at, kind, title, is_mine")
          .gte("starts_at", from)
          .lt("starts_at", to)
          .order("starts_at");
        if (error) return setError(error.message);
        rows = data as Slot[];
      }
      setError(null);
      setSlots(rows);
      setLoadedDay(forDay);
      setRefreshKey((k) => k + 1);
    },
    [supabase, isStaff, profile.id],
  );

  // Fetch whenever the day changes.
  useEffect(() => {
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetching external data
    load(day);
  }, [ready, day, load]);

  // Live updates: the database broadcasts {space_id, day} (no names) after every
  // change; refetch if it's the day on screen.
  const dayRef = useRef(day);
  const loadRef = useRef(load);
  useEffect(() => {
    dayRef.current = day;
    loadRef.current = load;
  }, [day, load]);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let current: RealtimeChannel | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let connecting = false;

    const connect = async () => {
      if (connecting) return;
      connecting = true;
      // A channel joins with whatever token supabase-js has stored right now,
      // so fetch and store a fresh Clerk token first; otherwise the join can
      // race the token request, go out anonymous, and be refused.
      try {
        await supabase.realtime.setAuth();
      } catch (e) {
        console.warn("[realtime] could not get a token:", e);
      }
      connecting = false;
      if (disposed) return;
      const channel = supabase
        .channel("calendar", { config: { private: true } })
        .on("broadcast", { event: "booking_changed" }, ({ payload }) => {
          if (payload?.day === dayRef.current) loadRef.current(dayRef.current);
        });
      current = channel;
      channel.subscribe((status, err) => {
        if (disposed || channel !== current) return; // a channel we already dropped
        if (status === "SUBSCRIBED") {
          attempt = 0;
          setLive(true);
          loadRef.current(dayRef.current); // catch up on anything missed
          return;
        }
        console.warn(`[realtime] ${status}${err ? `: ${err.message}` : ""}`);
        setLive(false);
        // supabase-js won't rejoin a channel the server closed, so start a new one.
        current = null;
        supabase.removeChannel(channel);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, [1_000, 5_000, 10_000, 30_000][Math.min(attempt++, 3)]);
      });
    };
    connect();

    // Coming back to the tab/window: refresh now, and reconnect now if needed.
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      loadRef.current(dayRef.current);
      if (!current && !connecting) {
        clearTimeout(retryTimer);
        attempt = 0;
        connect();
      }
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
      if (current) supabase.removeChannel(current);
    };
  }, [ready, supabase]);

  // Fallback: if the live connection is down (some networks/browsers drop
  // WebSockets), refresh every 15 s so nobody sees a stale calendar for long.
  useEffect(() => {
    if (!ready || live) return;
    const t = setInterval(() => loadRef.current(dayRef.current), 15_000);
    return () => clearInterval(t);
  }, [ready, live]);

  const today = todayChicago();
  const nowMin = day === today ? minutesOf(new Date(now)) : null;
  const advanceLimit = now + 7 * 24 * 60 * 60 * 1000;
  const loading = loadedDay !== day;

  function slotState(space: Space, startMin: number): "open" | "past" | "locked" | "far" {
    if (!space.bookable_by.includes(profile.role)) return "locked";
    const end = chicagoTime(day, startMin + STEP).getTime();
    if (end <= now) return "past";
    if (!isStaff && chicagoTime(day, startMin).getTime() > advanceLimit) return "far";
    return "open";
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button className={btn} onClick={() => setDay((d) => stepOpenDay(d, -1))} aria-label="Previous day">
            ←
          </button>
          <button className={btn} onClick={() => setDay(today)}>
            Today
          </button>
          <button className={btn} onClick={() => setDay((d) => stepOpenDay(d, 1))} aria-label="Next day">
            →
          </button>
        </div>
        <h2 className="text-lg font-medium">
          {formatDay(day)}
          {day === today && <span className="ml-2 text-sm font-normal text-zinc-500">today</span>}
        </h2>
        <div className="ml-auto flex items-center gap-3 text-sm text-zinc-500">
          <span
            className="flex items-center gap-1.5"
            title={live ? "Changes appear instantly" : "Live connection unavailable; refreshing every 15 seconds"}
          >
            <span className={`h-2 w-2 rounded-full ${live ? "bg-emerald-500" : "bg-amber-500"}`} />
            {live ? "Live" : "Auto-refresh"}
          </span>
          <span className="capitalize">{profile.role}</span>
          {isStaff && (
            <Link href="/staff" className={btn}>
              Staff tools
            </Link>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {Object.entries(KIND_STYLE).map(([k, s]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${s.dot}`} />
            {s.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm ring-2 ring-emerald-500" />
          Yours
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm border border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900" />
          Free
        </span>
      </div>

      <MyBookings
        profile={profile}
        spaces={spaces}
        supabase={supabase}
        ready={ready}
        refreshKey={refreshKey}
        onView={setDay}
        onChanged={() => load(day)}
      />

      {error && (
        <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          Couldn’t load bookings: {error}
        </p>
      )}

      {!isOpenDay(day) ? (
        <div className="rounded-lg border border-zinc-200 p-6 text-center dark:border-zinc-800">
          <p className="font-medium">{day === today ? "Closed today" : "Closed this day"}</p>
          <p className="mt-1 text-sm text-zinc-500">Open Monday–Friday, 8:30 AM–5:00 PM.</p>
          <button className={`${btn} mt-4`} onClick={() => setDay(firstOpenDay(day))}>
            Go to {formatDay(firstOpenDay(day))}
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div
            className={`grid min-w-[720px] transition-opacity ${loading ? "opacity-60" : ""}`}
            style={{ gridTemplateColumns: `4.5rem repeat(${spaces.length}, minmax(0, 1fr))` }}
          >
            {/* Header row */}
            <div className="sticky left-0 z-20 border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900" />
            {spaces.map((s) => {
              const canBook = s.bookable_by.includes(profile.role);
              return (
                <div
                  key={s.id}
                  className="border-b border-l border-zinc-200 bg-zinc-50 px-2 py-2 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="text-xs text-zinc-500">
                    {canBook ? `${s.kind === "room" ? "Room" : "Pod"} · ${s.capacity}` : bookableLabel(s)}
                  </div>
                  {isStaff && day === today && (
                    <button
                      className="mt-1 text-xs font-medium text-amber-700 hover:underline dark:text-amber-400"
                      onClick={() => setSelection({ type: "walkin", space: s })}
                    >
                      + Walk-in now
                    </button>
                  )}
                </div>
              );
            })}

            {/* Time labels */}
            <div className="sticky left-0 z-20 bg-white dark:bg-zinc-950" style={{ height: ROWS * SLOT_H }}>
              {Array.from({ length: ROWS }, (_, i) => (
                <div
                  key={i}
                  className="pr-2 text-right text-[11px] leading-none text-zinc-500"
                  style={{ height: SLOT_H, paddingTop: 2 }}
                >
                  {formatClock(OPEN + i * STEP)}
                </div>
              ))}
            </div>

            {/* One column per space */}
            {spaces.map((space) => (
              <div
                key={space.id}
                className="relative border-l border-zinc-200 dark:border-zinc-800"
                style={{ height: ROWS * SLOT_H }}
              >
                {Array.from({ length: ROWS }, (_, i) => {
                  const startMin = OPEN + i * STEP;
                  const state = slotState(space, startMin);
                  return (
                    <button
                      key={i}
                      disabled={state !== "open"}
                      onClick={() => setSelection({ type: "new", space, day, startMin })}
                      className={`absolute inset-x-0 border-t border-zinc-100 text-left dark:border-zinc-900 ${
                        state === "open"
                          ? "hover:bg-emerald-50 focus-visible:bg-emerald-50 dark:hover:bg-emerald-950/40"
                          : state === "locked"
                            ? "cursor-not-allowed bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,rgba(0,0,0,0.04)_6px,rgba(0,0,0,0.04)_12px)] dark:bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,rgba(255,255,255,0.04)_6px,rgba(255,255,255,0.04)_12px)]"
                            : "cursor-not-allowed bg-zinc-50 dark:bg-zinc-900/60"
                      }`}
                      style={{ top: i * SLOT_H, height: SLOT_H }}
                      aria-label={`${space.name} ${formatClock(startMin)} ${state === "open" ? "free" : "unavailable"}`}
                    />
                  );
                })}

                {slots
                  .filter((b) => b.space_id === space.id && dayOf(new Date(b.starts_at)) === day)
                  .map((b) => {
                    const start = Math.max(OPEN, minutesOf(new Date(b.starts_at)));
                    const end = Math.min(CLOSE, minutesOf(new Date(b.ends_at)));
                    const style = KIND_STYLE[b.kind];
                    const who = b.booked_for?.display_name || b.booked_for?.email;
                    return (
                      <button
                        key={b.id}
                        onClick={() => setSelection({ type: "existing", slot: b, space })}
                        className={`absolute inset-x-1 z-10 overflow-hidden rounded-md border-l-4 px-1.5 py-0.5 text-left text-xs shadow-sm ${style.block} ${
                          b.is_mine ? "ring-2 ring-emerald-500" : ""
                        }`}
                        style={{
                          top: ((start - OPEN) / STEP) * SLOT_H + 1,
                          height: Math.max(((end - start) / STEP) * SLOT_H - 2, 18),
                        }}
                      >
                        <div className="truncate font-medium">{b.is_mine && b.kind === "reservation" ? "Your booking" : b.title || style.label}</div>
                        {isStaff && who && <div className="truncate opacity-80">{who}</div>}
                      </button>
                    );
                  })}

                {nowMin !== null && nowMin >= OPEN && nowMin <= CLOSE && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500"
                    style={{ top: ((nowMin - OPEN) / STEP) * SLOT_H }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!isStaff && (
        <p className="text-xs text-zinc-500">
          {profile.role === "student"
            ? "Students can book up to 2 hours, one upcoming booking at a time, up to 7 days ahead."
            : "Instructors can book up to 7 days ahead."}{" "}
          Open Monday–Friday, 8:30 AM–5:00 PM.
        </p>
      )}

      {selection && (
        <BookingPanel
          key={selectionKey(selection)}
          selection={selection}
          profile={profile}
          slots={slots}
          supabase={supabase}
          onClose={() => setSelection(null)}
          onChanged={() => {
            setSelection(null);
            load(day);
          }}
        />
      )}
    </div>
  );
}

function bookableLabel(s: Space) {
  if (s.bookable_by.length === 1 && s.bookable_by[0] === "staff") return "Staff only";
  if (!s.bookable_by.includes("student")) return "Instructors & staff";
  return "";
}

function selectionKey(s: Selection) {
  if (s.type === "existing") return `e-${s.slot.id}`;
  if (s.type === "walkin") return `w-${s.space.id}`;
  return `n-${s.space.id}-${s.day}-${s.startMin}`;
}
