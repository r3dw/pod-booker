"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import {
  CLOSE,
  STEP,
  chicagoTime,
  dayOf,
  formatClock,
  formatDay,
  formatDuration,
  formatRange,
  minutesOf,
} from "@/lib/time";
import type { Kind, Person, Profile, Slot, Space } from "@/lib/types";
import { btn, btnDanger, btnPrimary, field, label } from "@/components/ui";

const KIND_LABEL: Record<Kind, string> = {
  class: "Class",
  recurring: "Recurring session",
  reservation: "Reservation",
  walkin: "Walk-in",
};

export type Selection =
  | { type: "new"; space: Space; day: string; startMin: number }
  | { type: "existing"; slot: Slot; space: Space }
  | { type: "walkin"; space: Space };

type Props = {
  selection: Selection;
  profile: Profile;
  slots: Slot[];
  supabase: SupabaseClient;
  onClose: () => void;
  onChanged: () => void;
};

export function BookingPanel(props: Props) {
  const { selection, onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-t-xl bg-white p-5 shadow-xl sm:rounded-xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        {selection.type === "new" && <NewBooking {...props} selection={selection} />}
        {selection.type === "existing" && <Details {...props} selection={selection} />}
        {selection.type === "walkin" && <Walkin {...props} selection={selection} />}
      </div>
    </div>
  );
}

function PanelHeader({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-sm text-zinc-500">{subtitle}</p>
      </div>
      <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" aria-label="Close">
        ✕
      </button>
    </div>
  );
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-3 rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {error}
    </p>
  );
}

// ---------------------------------------------------------------------------

function NewBooking({ selection, profile, slots, supabase, onClose, onChanged }: Props & { selection: Extract<Selection, { type: "new" }> }) {
  const { space, day, startMin } = selection;
  const isStaff = profile.role === "staff";

  // Longest possible: to the next booking in this space, closing time, or 2 h for students.
  const nextStart = slots
    .filter((b) => b.space_id === space.id && dayOf(new Date(b.starts_at)) === day)
    .map((b) => minutesOf(new Date(b.starts_at)))
    .filter((m) => m > startMin)
    .reduce((a, b) => Math.min(a, b), CLOSE);
  const cap = profile.role === "student" ? Math.min(nextStart, startMin + 120) : nextStart;
  const durations: number[] = [];
  for (let m = STEP; startMin + m <= cap; m += STEP) durations.push(m);

  const [duration, setDuration] = useState(Math.min(60, durations.at(-1) ?? STEP));
  const [kind, setKind] = useState<Kind>("reservation");
  const [title, setTitle] = useState("");
  const [person, setPerson] = useState<Person | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc("create_booking", {
      p_space_id: space.id,
      p_starts_at: chicagoTime(day, startMin).toISOString(),
      p_ends_at: chicagoTime(day, startMin + duration).toISOString(),
      p_kind: kind,
      p_title: kind === "class" || kind === "recurring" || kind === "walkin" ? title || null : null,
      p_booked_for: kind === "class" || kind === "recurring" ? null : (person?.id ?? null),
    });
    setBusy(false);
    if (error) return setError(error.message);
    onChanged();
  }

  return (
    <>
      <PanelHeader title={`Book ${space.name}`} subtitle={formatDay(day)} onClose={onClose} />
      <div className="space-y-3">
        <label className="block">
          <span className={label}>Time</span>
          <select className={field} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {durations.map((m) => (
              <option key={m} value={m}>
                {formatClock(startMin)}–{formatClock(startMin + m)} ({formatDuration(m)})
              </option>
            ))}
          </select>
        </label>

        {isStaff && (
          <>
            <label className="block">
              <span className={label}>Type</span>
              <select className={field} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="reservation">Reservation</option>
                <option value="walkin">Walk-in</option>
                <option value="class">Class (one-off)</option>
                <option value="recurring">Recurring session (one-off)</option>
              </select>
            </label>
            {kind === "class" || kind === "recurring" ? (
              <label className="block">
                <span className={label}>Name (shown to everyone)</span>
                <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. MPCS 51238 section" />
              </label>
            ) : (
              <>
                <div>
                  <span className={label}>For</span>
                  <PersonPicker
                    supabase={supabase}
                    value={person}
                    onChange={setPerson}
                    emptyLabel={kind === "walkin" ? "Someone without an account" : "Myself"}
                  />
                </div>
                {kind === "walkin" && !person && (
                  <label className="block">
                    <span className={label}>Name note (staff only)</span>
                    <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" />
                  </label>
                )}
              </>
            )}
          </>
        )}
      </div>

      <ErrorText error={error} />

      <div className="mt-5 flex justify-end gap-2">
        <button className={btn} onClick={onClose}>
          Cancel
        </button>
        <button className={btnPrimary} disabled={busy || durations.length === 0} onClick={submit}>
          {busy ? "Booking…" : "Book"}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function Details({ selection, profile, supabase, onClose, onChanged }: Props & { selection: Extract<Selection, { type: "existing" }> }) {
  const { slot, space } = selection;
  const isStaff = profile.role === "staff";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs] = useState(() => Date.now());
  const ended = new Date(slot.ends_at).getTime() <= nowMs;
  const canCancel = isStaff || (slot.is_mine && !ended);

  async function run(fn: string, args: Record<string, unknown>, question: string) {
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) return setError(error.message);
    onChanged();
  }

  const day = dayOf(new Date(slot.starts_at));
  const heading = slot.is_mine && slot.kind === "reservation" ? "Your booking" : slot.title || "Booked";

  return (
    <>
      <PanelHeader title={heading} subtitle={`${space.name} · ${formatDay(day)} · ${formatRange(slot.starts_at, slot.ends_at)}`} onClose={onClose} />

      {isStaff && (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-sm">
          <dt className="text-zinc-500">Type</dt>
          <dd>{KIND_LABEL[slot.kind]}</dd>
          <dt className="text-zinc-500">For</dt>
          <dd>{personLabel(slot.booked_for) ?? (slot.kind === "class" || slot.kind === "recurring" ? "—" : "No account")}</dd>
          <dt className="text-zinc-500">Booked by</dt>
          <dd>{personLabel(slot.booked_by) ?? "—"}</dd>
          <dt className="text-zinc-500">Made</dt>
          <dd>{slot.created_at ? new Date(slot.created_at).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }) : "—"}</dd>
          {slot.series_id && (
            <>
              <dt className="text-zinc-500">Series</dt>
              <dd>Repeats (part of a series)</dd>
            </>
          )}
        </dl>
      )}

      <ErrorText error={error} />

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {isStaff && slot.series_id && !ended && (
          <button
            className={btnDanger}
            disabled={busy}
            onClick={() =>
              run(
                "cancel_series",
                { p_series_id: slot.series_id, p_from: slot.starts_at },
                `Cancel ${slot.title ?? "this series"} on this date and every later date?`,
              )
            }
          >
            Cancel this and later dates
          </button>
        )}
        {canCancel && (
          <button
            className={btnDanger}
            disabled={busy}
            onClick={() => run("cancel_booking", { p_id: slot.id }, slot.series_id ? "Cancel just this date?" : "Cancel this booking?")}
          >
            {busy ? "Cancelling…" : slot.series_id ? "Cancel this date" : "Cancel booking"}
          </button>
        )}
        <button className={btn} onClick={onClose}>
          Close
        </button>
      </div>
    </>
  );
}

function personLabel(p: Person | null | undefined) {
  if (!p) return null;
  return p.display_name ? `${p.display_name} (${p.email})` : p.email;
}

// ---------------------------------------------------------------------------

function Walkin({ selection, supabase, onClose, onChanged }: Props & { selection: Extract<Selection, { type: "walkin" }> }) {
  const { space } = selection;
  const [minutes, setMinutes] = useState(60);
  const [person, setPerson] = useState<Person | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc("staff_walkin", {
      p_space_id: space.id,
      p_booked_for: person?.id ?? null,
      p_minutes: minutes,
      p_note: person ? null : note || null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    onChanged();
  }

  return (
    <>
      <PanelHeader title={`Walk-in: ${space.name}`} subtitle="Starts now. Ends early if the next booking or closing time comes first." onClose={onClose} />
      <div className="space-y-3">
        <div className="flex gap-2">
          {[30, 60, 90, 120].map((m) => (
            <button key={m} className={minutes === m ? btnPrimary : btn} onClick={() => setMinutes(m)}>
              {formatDuration(m)}
            </button>
          ))}
        </div>
        <div>
          <span className={label}>For (optional)</span>
          <PersonPicker supabase={supabase} value={person} onChange={setPerson} emptyLabel="Someone without an account" />
        </div>
        {!person && (
          <label className="block">
            <span className={label}>Name note (staff only, optional)</span>
            <input className={field} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        )}
      </div>
      <ErrorText error={error} />
      <div className="mt-5 flex justify-end gap-2">
        <button className={btn} onClick={onClose}>
          Cancel
        </button>
        <button className={btnPrimary} disabled={busy} onClick={submit} autoFocus>
          {busy ? "Logging…" : "Log walk-in"}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

/** Staff-only search over profiles (RLS lets staff read all profiles). */
export function PersonPicker({
  supabase,
  value,
  onChange,
  emptyLabel,
}: {
  supabase: SupabaseClient;
  value: Person | null;
  onChange: (p: Person | null) => void;
  emptyLabel: string;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Person[]>([]);

  useEffect(() => {
    const term = q.replace(/[,()%*\\]/g, " ").trim();
    if (term.length < 2) return;
    let stale = false;
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, email, display_name")
        .or(`email.ilike.*${term}*,display_name.ilike.*${term}*`)
        .order("email")
        .limit(8);
      if (!stale) setResults((data as Person[]) ?? []);
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q, supabase]);

  if (value) {
    return (
      <div className={`${field} flex items-center justify-between`}>
        <span className="truncate">{personLabel(value)}</span>
        <button className="ml-2 text-sm text-zinc-500 hover:underline" onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    );
  }

  const showResults = q.trim().length >= 2;
  return (
    <div className="relative">
      <input className={field} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email" />
      {!showResults && <p className="mt-1 text-xs text-zinc-500">Leave empty for {emptyLabel.toLowerCase()}.</p>}
      {showResults && (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">No matches. They need to sign in once first.</li>}
          {results.map((p) => (
            <li key={p.id}>
              <button
                className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                onClick={() => {
                  onChange(p);
                  setQ("");
                  setResults([]);
                }}
              >
                {personLabel(p)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
