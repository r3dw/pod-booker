"use client";

import { useState } from "react";
import { btn, btnPrimary } from "@/components/ui";
import { parseCsv, parseRegistrarRows, type ImportRow } from "@/lib/registrar-import";
import { useSupabase } from "@/lib/supabase-browser";
import { formatClock, formatDay } from "@/lib/time";
import type { Space } from "@/lib/types";

const DAY_LETTERS = ["", "M", "T", "W", "R", "F"];
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const short = (day: string) => formatDay(day).replace(/^\w+, /, "").replace(/(\w{3})\w* /, "$1 ");

type Result = { ok: true; created: number; conflicts: string[]; closed: number; past: number } | { ok: false; error: string };

/** Staff: import classes from a Registrar (Astra) export (.xlsx or .csv). */
export function ImportTab({ spaces }: { spaces: Space[] }) {
  const { supabase } = useSupabase();
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<number, Result>>({});
  const [busy, setBusy] = useState(false);

  async function onFile(file: File | undefined) {
    setRows(null);
    setResults({});
    setError(null);
    if (!file) return;
    setFileName(file.name);
    try {
      let data: (string | number | boolean | Date | null)[][];
      if (/\.csv$/i.test(file.name)) {
        data = parseCsv(await file.text());
      } else {
        // Read in the browser; the file is never uploaded.
        const { readSheet } = await import("read-excel-file/browser");
        data = (await readSheet(file)) as unknown as typeof data;
      }
      const parsed = parseRegistrarRows(data, spaces);
      if (parsed.error) return setError(parsed.error);
      setRows(parsed.rows);
    } catch (e) {
      setError(`Couldn’t read that file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const ready = rows?.filter((r) => r.problems.length === 0) ?? [];
  const done = Object.keys(results).length > 0;

  async function runImport() {
    setBusy(true);
    const next: Record<number, Result> = {};
    for (const r of ready) {
      const { data, error } = await supabase.rpc("create_series", {
        p_space_id: r.space!.id,
        p_kind: "class",
        p_title: r.title,
        p_first_day: r.firstDay,
        p_last_day: r.lastDay,
        p_weekdays: r.weekdays,
        p_start: toTime(r.startMin),
        p_end: toTime(r.endMin),
        p_skip_conflicts: true, // conflicting dates are listed below, never silently dropped
        p_skip_past: true, // meetings that already started this term are skipped
      });
      if (error) next[r.line] = { ok: false, error: error.message };
      else {
        const d = data as { created: number; skipped: string[]; closed: string[]; past: number };
        next[r.line] = { ok: true, created: d.created, conflicts: d.skipped, closed: d.closed.length, past: d.past };
      }
      setResults({ ...next });
    }
    setBusy(false);
  }

  const totalCreated = Object.values(results).reduce((n, r) => n + (r.ok ? r.created : 0), 0);

  return (
    <section>
      <p className="mb-4 text-sm text-zinc-500">
        Upload a Registrar class export (.xlsx or .csv). Each class becomes a series of bookings. Times are rounded out
        to the quarter hour, meetings that already started are skipped, closed days (holidays, breaks) are skipped, and
        any date that’s already booked is listed, not overwritten. The file is read in your browser and not uploaded.
      </p>

      <label className={`${btn} cursor-pointer`}>
        Choose file…
        <input
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          className="sr-only"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </label>
      {fileName && <span className="ml-3 text-sm text-zinc-500">{fileName}</span>}

      {error && (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {rows && (
        <>
          <p className="mt-4 text-sm">
            <span className="font-medium">{ready.length}</span> class{ready.length === 1 ? "" : "es"} ready to import
            {rows.length - ready.length > 0 && <span className="text-amber-700 dark:text-amber-400"> · {rows.length - ready.length} with problems (won’t be imported)</span>}
          </p>
          <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-3 py-2">Class</th>
                  <th className="px-3 py-2">Space</th>
                  <th className="px-3 py-2">Days</th>
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Dates</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((r) => {
                  const res = results[r.line];
                  return (
                    <tr key={r.line} className={r.problems.length ? "bg-amber-50/60 dark:bg-amber-950/30" : ""}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.title || r.raw}</div>
                        <div className="text-xs text-zinc-500">
                          Row {r.line}
                          {r.duplicates > 0 && ` · ${r.duplicates} duplicate row${r.duplicates === 1 ? "" : "s"} merged`}
                        </div>
                      </td>
                      <td className="px-3 py-2">{r.space?.name ?? <span className="text-zinc-500">{r.roomRaw}</span>}</td>
                      <td className="px-3 py-2">{r.weekdays.map((d) => DAY_LETTERS[d]).join("")}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.problems.some((p) => p.includes("time")) ? (
                          r.timesRaw
                        ) : (
                          <>
                            {formatClock(r.startMin)}–{formatClock(r.endMin)}
                            {r.rounded && <div className="text-xs text-zinc-500">from {r.timesRaw}</div>}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.firstDay && r.lastDay ? `${short(r.firstDay)} – ${short(r.lastDay)}` : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {r.problems.length > 0 ? (
                          <ul className="text-xs text-amber-800 dark:text-amber-300">
                            {r.problems.map((p) => (
                              <li key={p}>{p}</li>
                            ))}
                          </ul>
                        ) : !res ? (
                          <span className="text-xs text-zinc-500">{busy ? "Waiting…" : "Ready"}</span>
                        ) : res.ok ? (
                          <div className="text-xs">
                            <div className="font-medium text-emerald-700 dark:text-emerald-400">
                              Added {res.created} date{res.created === 1 ? "" : "s"}
                            </div>
                            {res.past > 0 && <div className="text-zinc-500">{res.past} already past</div>}
                            {res.closed > 0 && <div className="text-zinc-500">{res.closed} on closed days</div>}
                            {res.conflicts.length > 0 && (
                              <div className="text-amber-800 dark:text-amber-300">
                                Already booked, skipped: {res.conflicts.map(short).join(", ")}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-red-700 dark:text-red-300">{res.error}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-end gap-3">
            {done && !busy && (
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                Done: {totalCreated} booking{totalCreated === 1 ? "" : "s"} added.
              </span>
            )}
            <button className={btnPrimary} disabled={busy || done || ready.length === 0} onClick={runImport}>
              {busy ? "Importing…" : `Import ${ready.length} class${ready.length === 1 ? "" : "es"}`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
