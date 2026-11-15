"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { btn, btnPrimary, field, label } from "@/components/ui";
import { useSupabase } from "@/lib/supabase-browser";
import {
  CLOSE,
  OPEN,
  STEP,
  addDays,
  dayOf,
  firstOpenDay,
  formatClock,
  formatDay,
  formatRange,
  isoWeekday,
  todayChicago,
} from "@/lib/time";
import type { Kind, Profile, Role, Space } from "@/lib/types";

const help = "mb-4 text-sm text-zinc-500";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

const TABS = [
  { id: "add", label: "Add class or session" },
  { id: "classes", label: "Classes & sessions" },
  { id: "people", label: "People and roles" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export default function StaffTools({ me, spaces, initialTab }: { me: Profile; spaces: Space[]; initialTab?: string }) {
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.id === initialTab) ? (initialTab as Tab) : "add");

  function choose(t: Tab) {
    setTab(t);
    // Keep the tab in the URL so reloads and shared links open the same tab.
    window.history.replaceState(null, "", `/staff?tab=${t}`);
  }

  return (
    <div>
      <div role="tablist" className="mb-5 flex flex-wrap gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => choose(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.id
                ? "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "add" && <SeriesForm spaces={spaces} />}
        {tab === "classes" && <SeriesList spaces={spaces} />}
        {tab === "people" && <People me={me} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add a class or recurring session (expands to one booking per date)

const timeOptions: number[] = [];
for (let m = OPEN; m <= CLOSE; m += STEP) timeOptions.push(m);
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function defaults(spaces: Space[]) {
  const start = firstOpenDay(todayChicago());
  return {
    spaceId: spaces.find((s) => s.kind === "room")?.id ?? spaces[0]?.id,
    kind: "class" as Kind,
    title: "",
    firstDay: start,
    lastDay: addDays(start, 7 * 10),
    weekdays: [isoWeekday(start)],
    startMin: 10 * 60,
    endMin: 11 * 60,
  };
}

function SeriesForm({ spaces }: { spaces: Space[] }) {
  const { supabase } = useSupabase();
  const [form, setForm] = useState(() => defaults(spaces));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Any edit clears the last outcome so stale messages don't linger.
  function edit<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setConflict(null);
    setError(null);
    setResult(null);
  }

  async function submit(skipConflicts: boolean) {
    setBusy(true);
    setError(null);
    setResult(null);
    const { data, error } = await supabase.rpc("create_series", {
      p_space_id: form.spaceId,
      p_kind: form.kind,
      p_title: form.title,
      p_first_day: form.firstDay,
      p_last_day: form.lastDay,
      p_weekdays: [...form.weekdays].sort(),
      p_start: toTime(form.startMin),
      p_end: toTime(form.endMin),
      p_skip_conflicts: skipConflicts,
    });
    setBusy(false);
    if (error) {
      if (error.code === "23P01" && error.message.startsWith("Conflicts on: ")) {
        return setConflict(error.message.slice("Conflicts on: ".length));
      }
      return setError(error.message);
    }
    const r = data as { created: number; skipped: string[] };
    setConflict(null);
    setResult(
      `Added “${form.title.trim()}”: ${r.created} date${r.created === 1 ? "" : "s"}.` +
        (r.skipped.length ? ` Skipped (already booked): ${r.skipped.map(shortDay).join(", ")}.` : ""),
    );
    setForm(defaults(spaces));
  }

  const canSubmit = form.title.trim() && form.weekdays.length > 0 && form.endMin > form.startMin && form.lastDay >= form.firstDay;

  return (
    <section>
      <p className={help}>
        Creates one booking per matching date. If any date is already booked, nothing is added until you choose to skip
        those dates.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={label}>Name (shown to everyone)</span>
          <input className={field} value={form.title} onChange={(e) => edit("title", e.target.value)} placeholder="e.g. MPCS 51238 lab" />
        </label>
        <label className="block">
          <span className={label}>Type</span>
          <select className={field} value={form.kind} onChange={(e) => edit("kind", e.target.value as Kind)}>
            <option value="class">Class</option>
            <option value="recurring">Recurring session</option>
          </select>
        </label>
        <label className="block">
          <span className={label}>Space</span>
          <select className={field} value={form.spaceId} onChange={(e) => edit("spaceId", Number(e.target.value))}>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>First date</span>
          <input type="date" className={field} value={form.firstDay} onChange={(e) => edit("firstDay", e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Last date</span>
          <input type="date" className={field} value={form.lastDay} onChange={(e) => edit("lastDay", e.target.value)} />
        </label>
        <div className="sm:col-span-2">
          <span className={label}>Repeats on</span>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((d, i) => {
              const n = i + 1;
              const on = form.weekdays.includes(n);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  className={on ? btnPrimary : btn}
                  onClick={() => edit("weekdays", on ? form.weekdays.filter((x) => x !== n) : [...form.weekdays, n])}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
        <label className="block">
          <span className={label}>Starts</span>
          <select className={field} value={form.startMin} onChange={(e) => edit("startMin", Number(e.target.value))}>
            {timeOptions.slice(0, -1).map((m) => (
              <option key={m} value={m}>
                {formatClock(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>Ends</span>
          <select className={field} value={form.endMin} onChange={(e) => edit("endMin", Number(e.target.value))}>
            {timeOptions.slice(1).map((m) => (
              <option key={m} value={m} disabled={m <= form.startMin}>
                {formatClock(m)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {conflict && (
        <div role="alert" className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">Already booked on: {conflict.split(", ").map(shortDay).join(", ")}</p>
          <p className="mt-1">Nothing has been added yet. Add the other dates and skip these, or go back and change the details.</p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
          {result}
        </p>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {conflict ? (
          <>
            <button className={btn} disabled={busy} onClick={() => setConflict(null)}>
              Back to editing
            </button>
            <button className={btnPrimary} disabled={busy} onClick={() => submit(true)}>
              {busy ? "Adding…" : "Add the other dates (skip conflicts)"}
            </button>
          </>
        ) : (
          <button className={btnPrimary} disabled={busy || !canSubmit} onClick={() => submit(false)}>
            {busy ? "Adding…" : "Add"}
          </button>
        )}
      </div>
    </section>
  );
}

function shortDay(day: string) {
  return formatDay(day).replace(/^(\w+), /, (_, w: string) => `${w.slice(0, 3)} `);
}

// ---------------------------------------------------------------------------
// Upcoming series (overview; cancelling happens from the calendar)

type SeriesRow = { series_id: string; title: string | null; kind: Kind; space_id: number; starts_at: string; ends_at: string };
type SeriesSummary = { id: string; title: string; kind: Kind; space: string; next: SeriesRow; count: number; days: string; last: string };

function SeriesList({ spaces }: { spaces: Space[] }) {
  const { supabase, ready } = useSupabase();
  const [series, setSeries] = useState<SeriesSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("bookings")
      .select("series_id, title, kind, space_id, starts_at, ends_at")
      .not("series_id", "is", null)
      .eq("status", "active")
      .gte("ends_at", new Date().toISOString())
      .order("starts_at");
    if (error) return setError(error.message);
    const groups = new Map<string, SeriesRow[]>();
    for (const r of data as SeriesRow[]) groups.set(r.series_id, [...(groups.get(r.series_id) ?? []), r]);
    setSeries(
      [...groups.entries()].map(([id, rows]) => ({
        id,
        title: rows[0].title ?? "Untitled",
        kind: rows[0].kind,
        space: spaces.find((s) => s.id === rows[0].space_id)?.name ?? "?",
        next: rows[0],
        count: rows.length,
        days: [...new Set(rows.map((r) => isoWeekday(dayOf(new Date(r.starts_at)))))]
          .sort()
          .map((n) => WEEKDAYS[n - 1])
          .join(", "),
        last: dayOf(new Date(rows[rows.length - 1].starts_at)),
      })),
    );
    setError(null);
  }, [supabase, spaces]);

  useEffect(() => {
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetching external data
    load();
  }, [ready, load]);

  return (
    <section>
      <p className={help}>
        Classes and recurring sessions with dates still ahead. To cancel, open any date on the calendar and choose
        “Cancel this date” or “Cancel this and later dates”.
      </p>
      {error && <p className="mb-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      {series === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : series.length === 0 ? (
        <p className="text-sm text-zinc-500">None yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {series.map((s) => {
            const nextDay = dayOf(new Date(s.next.starts_at));
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <div className="font-medium">
                    {s.title} <span className="text-sm font-normal text-zinc-500">· {s.kind === "class" ? "Class" : "Recurring session"}</span>
                  </div>
                  <div className="text-sm text-zinc-500">
                    {s.space} · {s.days} · {formatRange(s.next.starts_at, s.next.ends_at)} · next {shortDay(nextDay)} · {s.count} left, until{" "}
                    {shortDay(s.last)}
                  </div>
                </div>
                <Link className={btn} href={`/?day=${nextDay}`}>
                  View
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// People and roles

type PersonRow = { id: string; email: string; display_name: string | null; role: Role };

const roleSelect =
  "w-36 shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-950";

function People({ me }: { me: Profile }) {
  const { supabase, ready } = useSupabase();
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(
    async (term: string) => {
      let query = supabase.from("profiles").select("id, email, display_name, role").order("email").limit(50);
      const t = term.replace(/[,()%*\\]/g, " ").trim();
      if (t) query = query.or(`email.ilike.*${t}*,display_name.ilike.*${t}*`);
      const { data, error } = await query;
      if (error) return setError(error.message);
      setPeople(data as PersonRow[]);
      setError(null);
    },
    [supabase],
  );

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => load(q), 200);
    return () => clearTimeout(t);
  }, [ready, q, load]);

  async function setRole(p: PersonRow, role: Role) {
    setSavingId(p.id);
    const { error } = await supabase.rpc("set_user_role", { p_user_id: p.id, p_role: role });
    setSavingId(null);
    if (error) return setError(error.message);
    load(q);
  }

  return (
    <section>
      <p className={help}>
        Everyone starts as a student after their first sign-in. People appear here once they have signed in.
      </p>
      <input className={`${field} mb-3`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email" />
      {error && <p className="mb-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      {people === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : people.length === 0 ? (
        <p className="text-sm text-zinc-500">No one found.</p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {people.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {p.display_name || p.email}
                  {p.id === me.id && <span className="ml-2 text-xs font-normal text-zinc-500">(you)</span>}
                </div>
                {p.display_name && <div className="truncate text-sm text-zinc-500">{p.email}</div>}
              </div>
              <select
                className={roleSelect}
                value={p.role}
                disabled={savingId === p.id || p.id === me.id}
                title={p.id === me.id ? "You can’t change your own role" : undefined}
                onChange={(e) => setRole(p, e.target.value as Role)}
                aria-label={`Role for ${p.email}`}
              >
                <option value="student">Student</option>
                <option value="instructor">Instructor</option>
                <option value="staff">Staff</option>
              </select>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
