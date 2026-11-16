# Study Room Booking — Implementation Plan

Two phases, matching the proposal: **Phase 1 = v1 (due Tue Nov 17, 5:30 PM)**, **Phase 2 = v2 (fair, Dec 1)**.
Focus: **Systems**. Stack: Vercel, Clerk, Supabase. No Railway.

---

## 0. Decisions (status as of Nov 10)

| # | Decision | Recommendation |
|---|----------|----------------|
| 1 | Front-end framework | **Decided:** Next.js 16 (App Router) + TypeScript + Tailwind, code in `src/`. Scaffolded. |
| 2 | Where the app lives | **Decided:** this repo, `/Users/rod/projects/pod-booking` (GitHub `r3dw/pod-booker`; local folder keeps the old name). `r3dw/proj` stays as the submitted proposal. |
| 3 | Booking rules for students | **Decided:** max 2 h per booking, only within open hours. **Still proposed, not confirmed:** 30-min steps, max 1 future booking at a time, up to 7 days ahead. |
| 4 | Open hours | **Decided:** 8:30 AM–5:00 PM, Monday–Friday only (America/Chicago). No weekend bookings. |
| 5 | Space names | **Decided:** Room 208 (staff + instructors), Room 213 (staff only), Pods 206, 207, 215, 216. Rooms seat ~8, pods ~5. |
| 6 | Astra export | **Built (Nov 16):** Staff tools → Import from Registrar reads the .xlsx/.csv export in the browser. Course/Section → course, section, type (LEC, SEM, DIS, LAB, SCR, TUT, STU); R = Thursday; times rounded out to the quarter hour; duplicate rows merged; past meetings and closed days skipped; conflicts listed per class. |
| 7 | Who sees names | **Decided (Nov 15):** only staff. Instructors see the same calendar as students (class names, booked/free). Changed from the proposal, which said instructors see names. |
| 8 | Closed and special days | **Decided (Nov 16):** `calendar_days` table. *Closed* (nobody books, imports skip): University holidays, Thanksgiving week, from the end of finals to the start of the next quarter. *Staff only*: finals week (classes and staff bookings only). *Note*: reading days (banner, normal bookings). Seeded for 2026–27; summer left open. Winter/Spring follow the Autumn pattern (to confirm). |
| 9 | Booking steps | **Decided (Nov 16):** staff and imported classes use quarter hours (15 min); students and instructors keep half hours. |

---

## 1. Architecture

```
Browser (Next.js)  ──Clerk session token──▶  Supabase (Postgres + RLS)
     ▲                                             │
     └──────── Supabase Realtime (broadcast) ◀─────┘  trigger on bookings
```

- **Auth:** Clerk email-code sign-in. Supabase's *Clerk third-party auth* integration lets Supabase accept the Clerk token directly, so RLS can use `auth.jwt()->>'sub'` (the Clerk user id).
- **uchicago.edu only:** Use Clerk's domain allowlist if your plan includes it (*verify: it may be a paid feature*). Either way, enforce it in the database too: profile creation rejects any email not ending in `@uchicago.edu`. Never rely on the UI alone.
- **Roles live in our database**, not in Clerk: `profiles.role` ∈ `student | instructor | staff`. Everyone starts as `student`; staff promote people. RLS calls a helper `app.current_role()`.
- **Profile creation:** lazy upsert on first sign-in (server action). No webhook needed for v1.
- **All writes go through Postgres functions (RPC)**, e.g. `create_booking(...)`, which check role, space permission, rules and blocks in one place. Tables have no direct insert/update policy for non-staff.

### The privacy + realtime problem (the riskiest design point)

RLS hides **rows**, not **columns**, and Realtime "Postgres Changes" sends whole rows. If students could subscribe to `bookings`, they'd receive other students' names.

Solution:
1. Students and instructors read through a view, **`calendar_public`**: space, start, end, kind, and a title that is the class/session name for classes and recurring sessions and just `Booked` for personal reservations. Staff read `bookings` directly.
2. A trigger on `bookings` sends a **minimal Realtime broadcast**: `{space_id, day}` with no names. Clients that receive it refetch that day from the view (or table, for staff).

Prototype this on day 1. Everything else is ordinary.

---

## 2. Data model (Phase 1)

```sql
create extension if not exists btree_gist;

create type user_role    as enum ('student','instructor','staff');
create type space_kind   as enum ('room','pod');
create type booking_kind as enum ('class','recurring','reservation','walkin');
create type booking_status as enum ('active','cancelled');

profiles (
  id            text primary key,        -- Clerk user id
  email         text unique not null check (email ilike '%@uchicago.edu'),
  display_name  text,
  role          user_role not null default 'student',
  created_at    timestamptz default now()
)

spaces (
  id            smallint primary key,
  name          text not null,           -- "Pod 1" ...
  kind          space_kind not null,
  capacity      smallint not null,
  bookable_by   user_role[] not null,    -- pods: all three; room A: instructor+staff; room B: staff
  active        boolean default true
)

bookings (
  id            uuid primary key default gen_random_uuid(),
  space_id      smallint references spaces,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null check (ends_at > starts_at),
  during        tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,
  kind          booking_kind not null,
  title         text,                    -- class / session name; null for personal
  booked_for    text references profiles,  -- null for classes
  booked_by     text references profiles not null,
  series_id     uuid,                    -- groups rows from one recurring entry or CSV row
  status        booking_status default 'active',
  created_at    timestamptz default now(),
  exclude using gist (space_id with =, during with &&) where (status = 'active')
)
```

- **No double-booking** is the exclusion constraint. Two simultaneous clicks: one succeeds, the other gets a constraint error that the UI shows as "just taken".
- **Recurring sessions** are expanded into individual rows at entry time, sharing a `series_id`. That's simpler than storing recurrence rules, and the overlap constraint keeps working. Edit or delete a series by `series_id`.
- **Time zone:** store `timestamptz`, display in `America/Chicago`.

### RLS summary (Phase 1)

| Table / view | student | instructor | staff |
|---|---|---|---|
| `spaces` | read | read | read / write |
| `profiles` | own row | own row | all |
| `bookings` | own rows (booked_for = me) | own rows | all |
| `calendar_public` | read | read | read |
| writes | via RPC only | via RPC only | RPC + direct |

---

## 3. Phase 1 — v1 (Nov 10 → Nov 17)

**Goal:** a signed-in uchicago.edu user sees six live calendars and can book a free slot. Staff can log walk-ins and enter classes.

| Day | Work | Done when |
|-----|------|-----------|
| **Tue Nov 10** | New repo, Next.js app, deploy an empty shell to Vercel. Supabase project + Clerk app. Connect Clerk ↔ Supabase third-party auth. Schema migration (above). Seed 6 spaces. | A signed-in user's Clerk id shows in a Supabase query run through RLS. |
| **Wed Nov 11** | Profile upsert with the uchicago.edu check. Role helper + RLS policies. `calendar_public` view. Broadcast trigger. **Test RLS as each role** (SQL tests, or three test accounts). | A student account can't read another student's booking, by any route. Two inserts into the same slot: one fails. |
| **Thu Nov 12** | Day view: 6 spaces × time grid, color-coded by kind (class / recurring / reservation / walk-in / free). Data from the view or table depending on role. | Matches the mockup on the proposal page, with real data. |
| **Fri Nov 13** | Realtime: subscribe to the broadcast and refetch the affected day. Day navigation (prev / next / today). Staff detail panel (who, booked by, when made). | Two browsers side by side: a booking in one appears in the other within ~1 s. |
| **Sat Nov 14** | `create_booking` RPC with rules (role may book this space, within hours, length/advance limits, not in past). Booking UI: click a free slot → confirm. Cancel own booking. | A student can't book the staff-only room even by calling the RPC directly. |
| **Sun Nov 15** | Staff tools: book on behalf (search profile by email/name → `booked_for`), quick walk-in ("this pod, now → +1 h"). Admin form for a one-off class or recurring session (expands to rows). Astra CSV import: upload → preview → insert with `series_id`; conflicts are listed, not silently dropped. Staff page to change a user's role. | A walk-in takes ≤ 3 clicks on the desk computer. A real Astra file imports. |
| **Mon Nov 16** | Real-user testing: one student, one instructor, a desk attendant. Fix what they hit. Empty, loading and error states. Mobile layout. | Each tester completes their main task unaided. |
| **Tue Nov 17** | Final deploy, set free-tier usage limits and alerts, short write-up. **v1 due 5:30 PM.** | |

**Cut order if behind** (last to first): CSV import (fall back to the manual series form) → cancel own booking → mobile polish. **Don't cut:** RLS tests, the overlap constraint, realtime.

**Phase 1 is done when:** every v1 bullet on the proposal page works on the live site for a real account in each role.

---

## 4. Phase 2 — v2 (Nov 18 → Dec 1)

Built in the proposal's priority order. Nov 24 is Thanksgiving week, so plan for about 1.5 working weeks.

| Order | Feature | Implementation |
|-------|---------|----------------|
| 1 | **Move / cancel with reason + notify** | `booking_changes` table (booking, old/new time or space, reason, by, at). RPCs `staff_cancel_booking`, `staff_move_booking` (a move is checked by the same overlap constraint). Notification: an in-app `notifications` table shown on sign-in, plus email. Email needs a sender: **Resend (free tier)** is the simplest choice, and it's a new service, so decide whether it's worth it or in-app only is enough. |
| 2 | **Instructor priority** | Needs a definition first. Proposed: instructors can book further ahead (e.g. 21 days vs 7) and request a slot held by a student reservation; staff approve, which runs the move/cancel flow from #1. **Confirm the rule you want.** |
| 3 | **Warnings log** | `warnings` table (user, issued_by, reason, category, date). Staff-only RLS: no policy for anyone else, so it doesn't exist to them. Staff page per user: history + "add warning". |
| 4 | **Blocking** | `profiles.blocked_at`, `blocked_reason`. `create_booking` rejects blocked users with a clear message. Staff action to block and unblock, logged. |
| 6 | **Room photos** *(v1 if time, else v2)* | A photo per space (column header thumbnail, larger on click). Store images in `public/spaces/`, add `spaces.photo_url`. Needs a photo of each room and pod. Available now in `../proj/images/`: `room-1.jpg` = Room 213, `room-2.jpg` = Room 208, `pod.jpg` = Pod 216 (reuse for the other pods until each has its own). |
| 5 | **Usage tracking** *(if time)* | SQL views: bookings per space per day, walk-ins (booked_by ≠ booked_for), peak hours, no-show data if you ever add check-in. A simple staff page with a table, not a dashboard. |

**Also for the fair:** a short demo script (two browsers, live booking appearing, the student vs staff view, an attempted double-booking failing), plus the interruption tally before vs after.

---

## 5. Testing approach

- **Database first:** SQL tests (Supabase CLI local + pgTAP, or a plain script) for the overlap constraint, each RLS policy per role, and each RPC rule. These protect the Systems focus.
- **Manual realtime check:** two browsers, every time realtime code changes.
- **Three standing test accounts** (student / instructor / staff), using uchicago.edu addresses you control, or Clerk test emails in development.

## 6. Free-tier notes

- **Supabase free:** projects pause after a week of inactivity. Keep it in use or check before the fair.
- **Clerk free:** monthly active user limit is far above this app's needs. Verify the allowlist feature.
- **Vercel Hobby:** fine for this use.
- Set usage limits and alerts on each when the account is created (Nov 10), not at the end.

## 7. Open questions (answers change the plan)

1. Student booking limits beyond the 2 h max: how far ahead, how many at once?
2. Instructor priority: what exactly should it do?
3. v2 notifications: email (adds Resend) or in-app only?
4. Astra CSV export: still needed for the importer.
