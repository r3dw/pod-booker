# Pod Booker

A live, login-only booking calendar for six study spaces (2 rooms, 4 pods) at UChicago Language Center.
Course project for *Design, Build, Ship* (MPCS 51238, Autumn 2026). Focus: **Systems**.

**Live site:** https://pod-booker.vercel.app (UChicago accounts only)

## The problem

The Language Center has six rooms that it can book at its discretion. We need to 
track the rooms' usage but using the university's system requires staff time and is clunky. Four of the rooms can be used by students for study rooms but students are not allowed to book the rooms in the university system, so they 
must ask someone at the front desk for help to determine what is available. Instructors can request to book the rooms, but the process requires submission of a request form which takes up to 24 hours to be processed. Additionally, students, instructors and staff can't easily tell which of the six spaces are available and for how long, though we post paper schedules on the doors. Staff keep answering "is anything open?", and printed weekly schedules go stale almost immediately. 

Pod Booker puts one live calendar in front of everyone.

## What it does (v1)

| | Students | Instructors | Staff |
|---|---|---|---|
| Sign in with an emailed code, `@uchicago.edu` only | ✓ | ✓ | ✓ |
| Live day calendar of all six spaces | ✓ | ✓ | ✓ |
| See class/session names and booked/free | ✓ | ✓ | ✓ |
| See **who** booked and who made the booking | | | ✓ |
| Book the pods | ✓ | ✓ | ✓ |
| Book Room 208 | | ✓ | ✓ |
| Book Room 213 | | | ✓ |
| Cancel own upcoming bookings; "My bookings" list and history | ✓ | ✓ | ✓ |
| Book for someone else, quick walk-ins | | | ✓ |
| Add classes and recurring sessions (expanded to dated bookings) | | | ✓ |
| Import classes from a Registrar export (.xlsx/.csv) | | | ✓ |
| Cancel any booking, one date or "this and later" of a series | | | ✓ |
| Change people's roles | | | ✓ |

**Booking rules** (enforced in the database): Monday–Friday, 8:30 AM–5:00 PM, America/Chicago;
nothing in the past. Students and instructors book in half-hour steps, up to 7 days ahead; staff
and imported classes can use quarter hours. Students: at most 2 hours per booking and one upcoming
booking at a time. The spaces are closed on University holidays, Thanksgiving week and between
quarters; during finals week only staff and classes can book; reading days show a banner.

## Architecture

```
Browser (Next.js 16, React 19)
   │  Clerk session token (JWT, includes sub + email)
   ▼
Supabase Postgres ── RLS policies + SECURITY DEFINER functions (all writes)
   │  trigger on bookings → realtime.send({space_id, day})  (private topic, no names)
   ▼
Supabase Realtime ──► every open calendar refetches that day
```

- **Hosting:** Vercel. **Auth:** Clerk (email code). **Data, rules, live updates:** Supabase. All free tiers.
- **Clerk → Supabase:** Supabase's Clerk third-party auth accepts the Clerk token directly, so
  Postgres sees `auth.jwt()->>'sub'` (the Clerk user id) and RLS can use it. No webhook, no second login.
- **Roles live in the database** (`profiles.role`: `student | instructor | staff`), not in Clerk.
  Everyone starts as a student; only staff can promote.

### Security model

- **UChicago only, enforced in Postgres.** A profile is created on first sign-in by
  `ensure_profile()`, which takes the email from the *signed* token (a custom Clerk session claim),
  never from the browser, and rejects anything that isn't `@uchicago.edu`. A Clerk account without
  a profile sees an empty calendar and can't book.
- **No direct writes.** Signed-in users can only `SELECT`, and RLS limits that to their own rows
  (staff: all rows). Every write goes through a `SECURITY DEFINER` function (`create_booking`,
  `cancel_booking`, `staff_walkin`, `create_series`, `cancel_series`, `set_user_role`) that checks the
  caller's role and the booking rules in one place. Anonymous users get nothing.
- **No double-booking.** A Postgres exclusion constraint (`btree_gist`, `space_id WITH =, during WITH &&`,
  active bookings only) makes overlaps impossible, even for two clicks at the same instant.
  A per-user advisory lock stops two quick clicks from both passing the "one upcoming booking" rule.

### The privacy + realtime problem

RLS hides rows, not columns, and Realtime "Postgres Changes" would send whole rows, including who
booked. So:

1. Students and instructors read **`calendar_public`**, a view with time, space, kind and a title
   that is the class/session name or just "Booked". It has no identity columns.
2. Live updates are a **broadcast** sent by a trigger: `{space_id, day}` only, on a *private*
   Realtime topic that only users with a profile can join. Clients refetch that day through their
   normal, RLS-protected query.

Making this reliable with Clerk tokens (which last 60 s) took some care: the client fetches a fresh
token before each channel join, never hands Realtime a nearly expired or empty token, refreshes on a
15 s heartbeat in a Web Worker (so background tabs aren't throttled), rejoins automatically, and
falls back to refreshing every 15 s while the live connection is down.

## Data model

- `profiles(id = Clerk user id, email, display_name, role)`
- `spaces(id, name, kind room|pod, capacity, bookable_by role[])`
- `bookings(space_id, starts_at, ends_at, during tstzrange, kind class|recurring|reservation|walkin,
  title, booked_for, booked_by, series_id, status active|cancelled)`
- `calendar_days(day, kind closed|staff_only|note, label)`: holidays, breaks, finals week and
  reading days, seeded from the 2026–27 academic calendar

Recurring classes/sessions are expanded into one row per date sharing a `series_id`, so the overlap
constraint keeps working and a series can be cancelled by id.

## Tests

`supabase/tests/01_rls_and_rules.sql`: about 75 SQL assertions run as anonymous, each role, and a
user with no profile: the uchicago.edu check, RLS on every table, the privacy of `calendar_public`,
every booking rule, the overlap constraint, series conflicts, closed and finals-week days,
quarter-hour rules, the Registrar import, role changes, and that broadcast
payloads contain no names. It runs inside a transaction that is rolled back, so it never changes
real data.

```sh
scripts/db.sh test
```

## Running locally

Requirements: Node 20+, a Clerk app, a Supabase project, and `psql` (`brew install libpq`) for
migrations and tests.

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the Clerk keys and the Supabase URL +
   **publishable** key. For migrations/tests, also add `SUPABASE_DB_URL` (Supabase → Connect →
   Session pooler). That one contains the database password: keep it out of Vercel and never
   prefix it with `NEXT_PUBLIC_`.
3. Clerk: enable the Supabase integration; add session-token claims
   `{"email": "{{user.primary_email_address}}", "name": "{{user.full_name}}"}`.
   Supabase: Authentication → Third-Party Auth → add Clerk with your Clerk domain.
4. Apply migrations in order: `scripts/db.sh apply supabase/migrations/<file>.sql`
5. `npm run dev` → http://localhost:3000. The first account starts as a student; promote it once
   with `scripts/db.sh sql "update public.profiles set role = 'staff' where email = '…'"`.

## Repository layout

```
src/app/              pages: calendar (/), staff tools (/staff), sign-in
src/components/       day view, booking dialogs, My bookings, staff tools
src/lib/              Supabase clients (server + browser), Chicago-time helpers, types
src/proxy.ts          Clerk middleware (Next 16 calls middleware "proxy")
supabase/migrations/  schema, RLS, functions, data changes (applied in order)
supabase/tests/       SQL test suite
scripts/db.sh         apply migrations / run tests / one-off SQL without printing the DB URL
PLAN.md               full plan, decisions, schedule, v2 roadmap
```

## Changes from the proposal

- **Instructors see the same calendar as students** (class names, booked/free). Only staff see names.
  Instructors who need to know who booked a space can ask staff.
- **Registrar import is built:** Staff tools → Import from Registrar reads the export in the browser,
  rounds class times out to the quarter hour, merges duplicate rows, skips past meetings and closed
  days, and lists any conflicts.
- **Additions:** "My bookings" (upcoming, past and cancelled), cancel "this and later dates" for series;
  closed, finals-week and reading days from the academic calendar; students and instructors see only
  the spaces they can book.

## Known limitations

- Clerk is on development keys (fine for this course; production keys need a custom domain).
- Clerk's bot protection can block sign-ups from VPNs or public Wi-Fi. Workaround: staff create the
  account in Clerk → Users. Under review before wider rollout.
- Supabase free projects pause after a week without activity.
- Room photos are planned (v1 if time, otherwise v2).

## v2 (Dec 1)

Move/cancel with a reason and notification; instructor priority; staff-only warnings log; blocking; visual update;
usage tracking if time allows. See `PLAN.md`.
