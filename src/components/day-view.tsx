"use client";

import type React from "react";
import Image from "next/image";
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
  formatShortDay,
  isOpenDay,
  minutesOf,
  stepOpenDay,
  todayChicago,
} from "@/lib/time";
import type { Profile, Slot, Space } from "@/lib/types";
import { BookingPanel, type Selection } from "./booking-panel";
import { AppHeader } from "./app-header";
import { MyBookings } from "./my-bookings";
import { SpacePhotoDialog, bookableText } from "./space-photo";
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

type SpecialDay = { kind: "closed" | "staff_only" | "note"; label: string };

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
  const [conn, setConn] = useState<"connecting" | "live" | "retrying">("connecting");
  const live = conn === "live";
  const [selection, setSelection] = useState<Selection | null>(null);
  const [photoSpace, setPhotoSpace] = useState<Space | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshKey, setRefreshKey] = useState(0);
  // Closed and staff-only days (holidays, breaks, finals week), keyed by "YYYY-MM-DD".
  const [specialDays, setSpecialDays] = useState<Map<string, SpecialDay>>(new Map());

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

  useEffect(() => {
    if (!ready) return;
    supabase
      .from("calendar_days")
      .select("day, kind, label")
      .then(({ data }) => {
        if (data) setSpecialDays(new Map((data as ({ day: string } & SpecialDay)[]).map((d) => [d.day, { kind: d.kind, label: d.label }])));
      });
  }, [ready, supabase]);

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
          setConn("live");
          loadRef.current(dayRef.current); // catch up on anything missed
          return;
        }
        console.warn(`[realtime] ${status}${err ? `: ${err.message}` : ""}`);
        setConn("retrying");
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

  // Show only the spaces this person can book: students see the 4 pods,
  // instructors the pods + Room 208, staff everything. (Display only; the
  // database enforces who may book what.)
  const columns = spaces.filter((s) => s.bookable_by.includes(profile.role));

  const today = todayChicago();
  const nowMin = day === today ? minutesOf(new Date(now)) : null;
  const advanceLimit = now + 7 * 24 * 60 * 60 * 1000;
  const loading = loadedDay !== day;

  const special = specialDays.get(day);
  const closedLabel = !isOpenDay(day) ? null : special?.kind === "closed" ? special.label : null;
  const staffOnly = special?.kind === "staff_only" ? special.label : null;
  const note = special?.kind === "note" ? special.label : null;
  const isClosed = !isOpenDay(day) || closedLabel !== null;
  /** Next weekday that isn't a closed day. */
  const nextOpenDay = (from: string) => {
    let d = firstOpenDay(from);
    for (let i = 0; i < 60 && specialDays.get(d)?.kind === "closed"; i++) d = stepOpenDay(d, 1);
    return d;
  };

  function slotState(space: Space, startMin: number): "open" | "past" | "locked" | "far" {
    if (!space.bookable_by.includes(profile.role)) return "locked";
    if (staffOnly && !isStaff) return "past";
    const end = chicagoTime(day, startMin + STEP).getTime();
    if (end <= now) return "past";
    if (!isStaff && chicagoTime(day, startMin).getTime() > advanceLimit) return "far";
    return "open";
  }

  return (
    <div className="space-y-4">
      <AppHeader>
        <span
          className={`font-medium ${live ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
          title={
            live
              ? "Changes appear instantly"
              : conn === "connecting"
                ? "Connecting to live updates…"
                : "Live connection unavailable; refreshing every 15 seconds"
          }
        >
          {live ? "Live" : conn === "connecting" ? "Connecting" : "Auto-refresh"}
        </span>
        <span className="hidden capitalize text-zinc-500 sm:inline">{profile.role}</span>
        {isStaff && (
          <Link href="/staff" className={btn}>
            Staff tools
          </Link>
        )}
      </AppHeader>

      {/* Day navigation */}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
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
          <span className="hidden sm:inline">{formatDay(day)}</span>
          <span className="sm:hidden">{formatShortDay(day)}</span>
          {day === today && <span className="ml-2 text-sm font-normal text-zinc-500">today</span>}
        </h2>
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

      {note && !isClosed && (
        <p className="rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
          <span className="font-medium">{note}:</span> the pods are open for study. Book as usual.
        </p>
      )}

      {staffOnly && !isClosed && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <span className="font-medium">{staffOnly}:</span>{" "}
          {isStaff ? "students and instructors can’t book today; staff and classes can." : "no reservations today."}
        </p>
      )}

      {isClosed ? (
        <div className="rounded-lg border border-zinc-200 p-6 text-center dark:border-zinc-800">
          <p className="font-medium">
            {day === today ? "Closed today" : "Closed this day"}
            {closedLabel && `: ${closedLabel}`}
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            {closedLabel ? "No bookings on this day." : "Open Monday–Friday, 8:30 AM–5:00 PM."}
          </p>
          <button className={`${btn} mt-4`} onClick={() => setDay(nextOpenDay(day))}>
            Go to {formatDay(nextOpenDay(day))}
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div
            className={`grid min-w-[calc(4rem+var(--cols)*4.5rem)] transition-opacity sm:min-w-[720px] ${loading ? "opacity-60" : ""}`}
            style={
              {
                gridTemplateColumns: `4rem repeat(${columns.length}, minmax(0, 1fr))`,
                "--cols": columns.length, // phones: ~72px per column, so 4 pods fit without scrolling
              } as React.CSSProperties
            }
          >
            {/* Header row */}
            <div className="sticky left-0 z-20 border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900" />
            {columns.map((s) => {
              return (
                <div
                  key={s.id}
                  className="flex flex-col border-b border-l border-zinc-200 bg-zinc-50 px-2 py-2 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  {s.photo_url && (
                    <button
                      onClick={() => setPhotoSpace(s)}
                      className="mb-1.5 hidden w-full overflow-hidden rounded sm:block"
                      aria-label={`Photo of ${s.name}`}
                    >
                      <Image src={s.photo_url} alt="" width={240} height={135} className="h-16 w-full object-cover transition-transform hover:scale-105" />
                    </button>
                  )}
                  <button
                    onClick={() => setPhotoSpace(s)}
                    className="whitespace-nowrap text-left text-sm font-medium decoration-dotted underline-offset-2 hover:underline"
                    title="Show photo"
                  >
                    {s.name}
                  </button>
                  <div className="flex items-center gap-1 text-xs text-zinc-500">
                    {s.kind === "room" ? "Room" : "Pod"} · {s.capacity}
                    {s.photo_url && (
                      // Phones hide the thumbnail; the camera shows that the name opens a photo.
                      <button onClick={() => setPhotoSpace(s)} aria-label={`Photo of ${s.name}`} className="sm:hidden">
                        <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 text-zinc-400">
                          <path d="M6.5 4.5 7.6 3h4.8l1.1 1.5H16A2 2 0 0 1 18 6.5v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.5ZM10 14a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0-1.6a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 0 1 0 3.8Z" />
                        </svg>
                      </button>
                    )}

                  </div>
                  {isStaff && !s.bookable_by.includes("student") && (
                    <div className="hidden text-xs text-zinc-500 sm:block">{bookableText(s)}</div>
                  )}
                  {isStaff && day === today && (
                    <button
                      // mt-auto pins it to the bottom of the header cell so all columns line up.
                      className="mt-auto self-start pt-1 text-xs font-medium text-amber-700 hover:underline dark:text-amber-400"
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
            {columns.map((space) => (
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

      {/* Legend: below the calendar so the top of the page stays for the date and the grid */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {Object.entries(KIND_STYLE).map(([k, st]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${st.dot}`} />
            {st.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm ring-2 ring-emerald-500" />
          Yours
        </span>
      </div>

      <p className="text-xs text-zinc-500">
        {isStaff
          ? "Staff can book any space in quarter hours, for themselves or others."
          : profile.role === "student"
            ? "Students can book up to 2 hours, one upcoming booking at a time, up to 7 days ahead."
            : "Instructors can book up to 3 hours, three upcoming bookings at a time, up to 7 days ahead."}{" "}
        Open Monday–Friday, 8:30 AM–5:00 PM.
      </p>

      {photoSpace && <SpacePhotoDialog space={photoSpace} onClose={() => setPhotoSpace(null)} />}

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


function selectionKey(s: Selection) {
  if (s.type === "existing") return `e-${s.slot.id}`;
  if (s.type === "walkin") return `w-${s.space.id}`;
  return `n-${s.space.id}-${s.day}-${s.startMin}`;
}
