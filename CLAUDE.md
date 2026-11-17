@AGENTS.md

# Pod Booker

A live, login-only booking calendar for 6 study spaces (2 rooms, 4 pods) at the user's workplace (UChicago).
Course project for Design, Build, Ship (MPCS 51238, Autumn 2026). Focus: **Systems**.

- **Plan:** `PLAN.md` is the v2 plan (due Dec 1). `PLAN-v1.md` has the decisions, schema, RLS design and v1 schedule. Read both first.
- **Proposal page:** `../proj` (repo `r3dw/proj`, already submitted). Leave it unchanged.
- **Stack:** Next.js 16 (App Router, TypeScript, Tailwind, `src/`), Clerk (email-code sign-in, uchicago.edu only), Supabase (Postgres, RLS, Realtime), Vercel. Free tiers only; no Railway.
- **Deadlines:** v1 Tue Nov 17, 5:30 PM (works end to end), v2 Dec 1 (project fair).

## Rules that must hold
- Only `@uchicago.edu` users. Enforce in the database, not just in Clerk or the UI.
- Roles (`student | instructor | staff`) live in `profiles`. Everyone starts as `student`; only staff can promote.
- Students **and instructors** see class/session names and booked/free only, never who booked. Only staff see names. (Decided Nov 15; the submitted proposal said instructors would see names.) Live updates must not leak names (see PLAN-v1.md, "The privacy + realtime problem").
- Double-booking is prevented by a Postgres exclusion constraint.
- Open hours: 8:30 AM–5:00 PM, Monday–Friday, America/Chicago. Students: max 2 h per booking, 1 upcoming. Instructors: max 3 h, 3 upcoming.

## Working with the user
- GitHub CLI can't authenticate (org account restriction). The user creates GitHub repos in the browser; push over HTTPS works.
- The user deploys on Vercel from their own account.
