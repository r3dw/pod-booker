// All calendar math is in America/Chicago wall-clock time.
// A "day" is a "YYYY-MM-DD" string; times of day are minutes after midnight.

export const TZ = "America/Chicago";
export const OPEN = 8 * 60 + 30; // 8:30
export const CLOSE = 17 * 60; // 17:00
export const STEP = 30;

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function chicagoParts(d: Date) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    min: Number(p.minute),
    s: Number(p.second),
  };
}

/** Minutes Chicago is offset from UTC at this instant (e.g. -360 in winter). */
function offsetMinutes(d: Date) {
  const p = chicagoParts(d);
  return (Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - d.getTime()) / 60000;
}

/** The instant of `minutes` after midnight on `day`, Chicago time. DST-safe. */
export function chicagoTime(day: string, minutes: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let t = guess - offsetMinutes(new Date(guess)) * 60000;
  const second = guess - offsetMinutes(new Date(t)) * 60000;
  if (second !== t) t = second;
  return new Date(t);
}

export function dayOf(d: Date): string {
  const p = chicagoParts(d);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function minutesOf(d: Date): number {
  const p = chicagoParts(d);
  return p.h * 60 + p.min + p.s / 60;
}

export function todayChicago(): string {
  return dayOf(new Date());
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

export const isOpenDay = (day: string) => isoWeekday(day) <= 5;

/** Step to the next (dir = 1) or previous (dir = -1) open weekday. */
export function stepOpenDay(day: string, dir: 1 | -1): string {
  let d = addDays(day, dir);
  while (!isOpenDay(d)) d = addDays(d, dir);
  return d;
}

/** Today if it's a weekday, otherwise the next Monday. */
export function firstOpenDay(day: string): string {
  return isOpenDay(day) ? day : stepOpenDay(day, 1);
}

export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function formatRange(startIso: string, endIso: string): string {
  return `${formatClock(minutesOf(new Date(startIso)))}–${formatClock(minutesOf(new Date(endIso)))}`;
}

export function formatDay(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(`${day}T12:00:00Z`));
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
