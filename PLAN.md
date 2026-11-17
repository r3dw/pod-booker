# Pod Booker: v2 plan

**v2 is due Tue Dec 1 (project fair).** Work runs Nov 18 → Dec 1. Thanksgiving week (Nov 23–27)
is mostly off, so plan for about 1.5 working weeks.

v1 (shipped Nov 17) and its decisions, schema, RLS design and day-by-day history are in
[`PLAN-v1.md`](PLAN-v1.md). The rules in `CLAUDE.md` still hold.

Items are listed in priority order. Each database change comes with SQL tests in
`supabase/tests/`.

---

## 1. Accountability: who cancelled and why *(from the Nov 17 security review)*

Today a cancellation only sets `status = 'cancelled'`. Nobody can tell who did it, when, or why,
and staff can cancel anything, including past bookings.

- Add `cancelled_by`, `cancelled_at` and `cancel_reason` to `bookings`. `cancel_booking` and
  `cancel_series` fill them in.
- A reason is required for staff and optional for students and instructors.
- A staff-only `booking_changes` history for cancels and moves (booking, old/new time or space,
  reason, who, when).
- In the app, staff see "Cancelled by … on …: reason" in booking details and under My bookings →
  Past & cancelled.

## 2. Move or cancel with a reason, and notify the person

- `staff_move_booking`: changes the time and/or space. The overlap constraint checks the new slot
  automatically. Each move writes to `booking_changes`.
- Notify the person: an in-app `notifications` table, shown on their next sign-in.
- **Decide:** email as well? It needs a sender (Resend's free tier), which adds a new service.

## 3. Conduct tools (staff only)

- **Warnings log:** a `warnings` table (person, issued by, reason, category, date). It has no RLS
  policy for non-staff, so other users can't see it at all. Staff see each person's history and
  can add a warning.
- **Blocking:** `profiles.blocked_at` and `blocked_reason`. `create_booking` rejects blocked users
  with a clear message. Block and unblock actions are logged.

## 4. Instructor priority

- **Decide the rule first.** Proposal: instructors can book further ahead (for example 21 days
  instead of 7), and can request a slot held by a student. Staff approve the request, which runs
  the move/cancel flow from item 2.
- Current instructor limits (set Nov 17): 3 hours per booking, 3 upcoming bookings, 7 days ahead.

## 5. Account hygiene *(from the Nov 17 security review)*

- **Re-sign-up lockout:** `profiles.email` is unique, so someone deleted in Clerk and signed up
  again gets a new Clerk id, and profile creation fails. Fix: let `ensure_profile` move the
  existing profile (role, bookings) to the new id when the verified email matches.
- **Email changes:** if an account's primary email is no longer `@uchicago.edu`, the existing
  profile keeps working for direct database calls. Fix: store the email check in the profile,
  updated on each sign-in, and treat a failing profile as "no profile" in `app.my_role()`.
- **Deactivate:** a staff action for people who leave. It could reuse blocking from item 3.

## 6. Next year's calendar

- A Staff tools tab to add, edit and delete `calendar_days` (closed, staff-only, note), so
  2027–28 needs no migration. Staff-only writes through a SECURITY DEFINER function, like
  everything else.

## 7. Usage tracking *(if time allows)*

- SQL views: bookings per space per day, walk-ins (`booked_by ≠ booked_for`), peak hours.
- A simple staff page with tables, not a dashboard.

## 8. Smaller items

- Photos of Pods 206, 207 and 215: add `public/spaces/pod-2xx.jpg` and update each pod's
  `photo_url`.
- Free-tier usage limits and alerts on Supabase, Vercel and Clerk.
- Rename the placeholder labels in the test file ("Room A", "Pod 1") to the real room names.
- Check that the Supabase project hasn't paused (free projects pause after a week without
  activity), especially after Thanksgiving week.
- Rename the Supabase project to `pod-booker` (dashboard only).

## 9. For the fair (Dec 1)

- **Demo script:**
  - two browsers, with a booking appearing live in the other
  - the student view next to the staff view (names only for staff)
  - a double-booking attempt failing
  - a Registrar import
- Before/after tally of "is anything open?" interruptions at the desk.
- **Optional:** Clerk production keys, which need a custom domain. Otherwise keep it under known
  limitations.

---

## Open questions

1. Email notifications (Resend) or in-app only?
2. What exactly should instructor priority do?
3. Should students and instructors also have to give a cancellation reason, or only staff?
