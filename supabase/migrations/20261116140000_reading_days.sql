-- Banner-only special days ("note"): no booking rules change.
-- Weekday reading days from the academic calendar (the rest of each reading
-- period falls on a weekend).

alter table public.calendar_days drop constraint calendar_days_kind_check;
alter table public.calendar_days
  add constraint calendar_days_kind_check check (kind in ('closed', 'staff_only', 'note'));

insert into public.calendar_days (day, kind, label) values
  ('2026-12-07', 'note', 'Reading day'),
  ('2027-03-08', 'note', 'Reading day'),
  ('2027-05-24', 'note', 'Reading day');
