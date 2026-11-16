// Turns rows from a Registrar (Astra) class export into class series to import.
//
// Expected columns (matched by header text, case-insensitive):
//   Course/Section  "CATA 12200/1 LEC" → course CATA 12200, section 1, Lecture
//   Days Met        "MWF", "TR" (R = Thursday)
//   Start Date / End Date   "9/28/2026" (or real date cells)
//   Start Time / End Time   "10:30 AM" (or real time cells)
//   Room            "C 208 - Classroom" → the space whose name ends in 208
//   Status          only "Scheduled" rows are imported
import { CLOSE, OPEN } from "@/lib/time";
import type { Space } from "@/lib/types";

const TYPE_LABELS: Record<string, string> = {
  LEC: "Lecture",
  SEM: "Seminar",
  DIS: "Discussion",
  LAB: "Lab",
  SCR: "Screening",
  TUT: "Tutorial",
  STU: "Studio",
};

const DAY_CODES: Record<string, number> = { M: 1, T: 2, W: 3, R: 4, F: 5 };
const QUARTER = 15;

export type ImportRow = {
  line: number; // spreadsheet row number (1 = header)
  raw: string; // Course/Section as written
  title: string; // shown on the calendar
  weekdays: number[];
  daysRaw: string;
  firstDay: string; // YYYY-MM-DD
  lastDay: string;
  startMin: number; // rounded out to the quarter hour
  endMin: number;
  timesRaw: string;
  rounded: boolean;
  roomRaw: string;
  space: Space | null;
  problems: string[]; // any problem → row is not imported
  duplicates: number; // identical rows merged into this one
};

type Cell = string | number | boolean | Date | null | undefined;

const COLUMNS = {
  course: "course/section",
  days: "days met",
  startDate: "start date",
  endDate: "end date",
  startTime: "start time",
  endTime: "end time",
  room: "room",
  status: "status",
} as const;

export function parseRegistrarRows(rows: Cell[][], spaces: Space[]): { rows: ImportRow[]; error?: string } {
  if (rows.length < 2) return { rows: [], error: "The file has no data rows." };
  const header = rows[0].map((c) => String(c ?? "").trim().toLowerCase());
  const col: Partial<Record<keyof typeof COLUMNS, number>> = {};
  for (const [key, name] of Object.entries(COLUMNS)) {
    const i = header.indexOf(name);
    if (i >= 0) col[key as keyof typeof COLUMNS] = i;
  }
  const missing = (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).filter((k) => col[k] === undefined && k !== "status");
  if (missing.length) {
    return { rows: [], error: `Missing column(s): ${missing.map((k) => COLUMNS[k]).join(", ")}. Is this a Registrar class export?` };
  }

  const out: ImportRow[] = [];
  const byKey = new Map<string, ImportRow>();

  rows.slice(1).forEach((r, idx) => {
    const get = (k: keyof typeof COLUMNS) => (col[k] === undefined ? null : r[col[k]!]);
    if (r.every((c) => c === null || c === undefined || String(c).trim() === "")) return; // blank line
    const problems: string[] = [];

    const raw = String(get("course") ?? "").trim();
    const title = courseTitle(raw);
    if (!raw) problems.push("No course/section");

    const daysRaw = String(get("days") ?? "").trim().toUpperCase();
    const weekdays = [...new Set([...daysRaw].map((ch) => DAY_CODES[ch]).filter(Boolean))].sort();
    if (!weekdays.length) problems.push(`No weekdays in “${daysRaw || "(blank)"}”`);
    if (/[SU]/.test(daysRaw)) problems.push("Meets on a weekend (spaces are closed)");

    const firstDay = toDay(get("startDate"));
    const lastDay = toDay(get("endDate"));
    if (!firstDay || !lastDay) problems.push("Unreadable start or end date");

    const s = toMinutes(get("startTime"));
    const e = toMinutes(get("endTime"));
    let startMin = 0;
    let endMin = 0;
    let rounded = false;
    if (s === null || e === null || e <= s) {
      problems.push("Unreadable start or end time");
    } else {
      startMin = Math.floor(s / QUARTER) * QUARTER;
      endMin = Math.ceil(e / QUARTER) * QUARTER;
      rounded = startMin !== s || endMin !== e;
      if (startMin < OPEN || endMin > CLOSE) problems.push("Outside open hours (8:30 AM–5:00 PM)");
    }

    const roomRaw = String(get("room") ?? "").trim();
    const number = roomRaw.match(/\b(\d{3})\b/)?.[1];
    const space = (number && spaces.find((sp) => sp.name.endsWith(number))) || null;
    if (!space) problems.push(`Room “${roomRaw || "(blank)"}” isn’t one of our spaces`);

    const status = col.status === undefined ? "Scheduled" : String(get("status") ?? "").trim();
    if (!/^scheduled$/i.test(status)) problems.push(`Status “${status || "(blank)"}”, only Scheduled classes are imported`);

    const row: ImportRow = {
      line: idx + 2,
      raw,
      title,
      weekdays,
      daysRaw,
      firstDay: firstDay ?? "",
      lastDay: lastDay ?? "",
      startMin,
      endMin,
      timesRaw: `${cellText(get("startTime"))}–${cellText(get("endTime"))}`,
      rounded,
      roomRaw,
      space,
      problems,
      duplicates: 0,
    };

    // The export often lists the same meeting more than once; merge identical rows.
    const key = [title, weekdays.join(""), row.firstDay, row.lastDay, startMin, endMin, space?.id].join("|");
    const seen = byKey.get(key);
    if (seen) {
      seen.duplicates += 1;
      return;
    }
    byKey.set(key, row);
    out.push(row);
  });

  return { rows: out };
}

/** "CATA 12200/1 LEC" → "CATA 12200 (Sec. 1, Lecture)"; anything else is kept as written. */
export function courseTitle(raw: string): string {
  const m = raw.match(/^\s*(.+?)\s*\/\s*([^\s/]+)\s*([A-Za-z]{2,4})?\s*$/);
  if (!m) return raw;
  const [, course, section, code] = m;
  const type = code ? (TYPE_LABELS[code.toUpperCase()] ?? code.toUpperCase()) : null;
  return `${course} (Sec. ${section}${type ? `, ${type}` : ""})`;
}

function cellText(c: Cell): string {
  if (c instanceof Date) return c.toISOString().slice(11, 16);
  return String(c ?? "").trim();
}

/** Date cell or "9/28/2026" / "2026-09-28" → "2026-09-28". */
function toDay(c: Cell): string | null {
  if (c instanceof Date) return c.toISOString().slice(0, 10); // date cells come back as UTC midnight
  const t = String(c ?? "").trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** "10:30 AM" / "13:50" / time cell / day fraction → minutes after midnight. */
function toMinutes(c: Cell): number | null {
  if (c instanceof Date) return c.getUTCHours() * 60 + c.getUTCMinutes();
  if (typeof c === "number") return c >= 0 && c < 1 ? Math.round(c * 1440) : null;
  const m = String(c ?? "").trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h > 23 || min > 59 ? null : h * 60 + min;
}

/** Minimal CSV reader (quoted fields, commas, newlines) for .csv exports. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
