-- "No profile, no data" everywhere: reading spaces now requires a profile
-- (i.e. a @uchicago.edu account), like the calendar, bookings and live updates.
-- Before, any signed-in Clerk account (e.g. a gmail.com sign-up) could read
-- the six space names and capacities.

drop policy "signed-in users read spaces" on public.spaces;

create policy "profiled users read spaces"
  on public.spaces for select to authenticated
  using ((select app.my_role()) is not null);
