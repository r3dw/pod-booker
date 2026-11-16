-- Closed / staff-only days, quarter-hour steps for staff, and import support.
--
-- calendar_days
--   closed      nobody can book; series and imports skip the day
--   staff_only  finals week: only staff bookings (incl. imported classes)
-- Booking steps: staff 15 min, students/instructors 30 min.
-- create_series gains p_skip_past (imports skip meetings that already started)
-- and reports the closed and past dates it skipped.

------------------------------------------------------------------------------
-- calendar_days
------------------------------------------------------------------------------

create table public.calendar_days (
  day   date primary key,
  kind  text not null check (kind in ('closed', 'staff_only')),
  label text not null
);

alter table public.calendar_days enable row level security;
revoke all on public.calendar_days from anon, authenticated;
grant select on public.calendar_days to authenticated;

create policy "profiled users read calendar days"
  on public.calendar_days for select to authenticated
  using ((select app.my_role()) is not null);

-- 2026–27 from the University holiday list (HR) and the academic calendar
-- (events.uchicago.edu/academic/calendar). Weekdays only. Summer is left open.
insert into public.calendar_days (day, kind, label)
select d::date, r.kind, r.label
from (values
  ('2026-11-23'::date, '2026-11-27'::date, 'closed',     'Thanksgiving break'),
  ('2026-12-08',       '2026-12-11',       'staff_only', 'Finals week'),
  ('2026-12-12',       '2027-01-03',       'closed',     'Winter break'),
  ('2027-01-18',       '2027-01-18',       'closed',     'Martin Luther King Jr. Day'),
  ('2027-03-09',       '2027-03-12',       'staff_only', 'Finals week'),
  ('2027-03-13',       '2027-03-21',       'closed',     'Spring break'),
  ('2027-05-25',       '2027-05-28',       'staff_only', 'Finals week'),
  ('2027-05-31',       '2027-05-31',       'closed',     'Memorial Day'),
  ('2027-06-18',       '2027-06-18',       'closed',     'Juneteenth (observed)'),
  ('2027-07-05',       '2027-07-05',       'closed',     'Independence Day (observed)'),
  ('2027-09-06',       '2027-09-06',       'closed',     'Labor Day')
) as r(first_day, last_day, kind, label)
cross join lateral generate_series(r.first_day, r.last_day, interval '1 day') d
where extract(isodow from d) between 1 and 5;

------------------------------------------------------------------------------
-- create_booking: closed / staff-only days; 15-min steps for staff
------------------------------------------------------------------------------

create or replace function public.create_booking(
  p_space_id   smallint,
  p_starts_at  timestamptz,
  p_ends_at    timestamptz,
  p_kind       public.booking_kind default 'reservation',
  p_title      text default null,
  p_booked_for text default null,
  p_series_id  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Booking rules. Change them here.
  c_tz                 constant text     := 'America/Chicago';
  c_open               constant time     := '08:30';
  c_close              constant time     := '17:00';
  c_student_max_length constant interval := '2 hours';
  c_max_advance        constant interval := '7 days';   -- students + instructors
  c_student_max_future constant int      := 1;          -- upcoming reservations at once
  c_origin             constant timestamptz := '2000-01-01 00:00:00+00';

  v_uid      text := app.uid();
  v_role     public.user_role := app.my_role();
  v_step     interval;                                  -- staff 15 min, others 30 min
  v_space    public.spaces;
  v_day      public.calendar_days;
  v_for      text;
  v_title    text := nullif(btrim(p_title), '');
  v_lstart   timestamp := p_starts_at at time zone c_tz;
  v_lend     timestamp := p_ends_at at time zone c_tz;
  v_upcoming int;
  v_id       uuid;
begin
  if v_role is null then
    raise exception 'Your account has no profile yet. Reload the page.' using errcode = '42501';
  end if;
  v_step := case when v_role = 'staff' then interval '15 minutes' else interval '30 minutes' end;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'End time must be after start time.' using errcode = '22023';
  end if;

  select * into v_space from public.spaces s where s.id = p_space_id and s.active;
  if not found then
    raise exception 'No such space.' using errcode = 'P0002';
  end if;
  if not (v_role = any (v_space.bookable_by)) then
    raise exception '% can''t be booked with your account.', v_space.name using errcode = '42501';
  end if;

  -- Who it's for, and which kinds each role may create.
  if v_role = 'staff' then
    if p_kind in ('class', 'recurring') then
      if v_title is null then
        raise exception 'Classes and sessions need a name.' using errcode = '22023';
      end if;
      v_for := null;
    elsif p_kind = 'walkin' then
      v_for := p_booked_for;               -- may be null: walk-up without an account
    else
      v_for := coalesce(p_booked_for, v_uid);
    end if;
    if v_for is not null and not exists (select 1 from public.profiles where id = v_for) then
      raise exception 'No such user.' using errcode = 'P0002';
    end if;
  else
    if p_kind <> 'reservation'
       or coalesce(p_booked_for, v_uid) <> v_uid
       or v_title is not null
       or p_series_id is not null then
      raise exception 'Only staff can book classes, walk-ins, or for someone else.'
        using errcode = '42501';
    end if;
    v_for := v_uid;
  end if;

  -- Open hours: Mon–Fri, 8:30–17:00 Chicago, within one day.
  if extract(isodow from v_lstart) not between 1 and 5
     or v_lend::date <> v_lstart::date
     or v_lstart::time < c_open
     or v_lend::time > c_close then
    raise exception 'Bookings must be Monday–Friday, 8:30 AM–5:00 PM.' using errcode = '22023';
  end if;

  -- Closed and staff-only days.
  select * into v_day from public.calendar_days where day = v_lstart::date;
  if found then
    if v_day.kind = 'closed' then
      raise exception 'Closed: %.', v_day.label using errcode = '22023';
    elsif v_day.kind = 'staff_only' and v_role <> 'staff' then
      raise exception '%: no reservations this day.', v_day.label using errcode = '22023';
    end if;
  end if;

  -- Time grid and past. Walk-ins start "now", so they skip the grid.
  if p_ends_at <= now() then
    raise exception 'That time has already passed.' using errcode = '22023';
  end if;
  if p_kind <> 'walkin' then
    if date_bin(v_step, p_starts_at, c_origin) <> p_starts_at
       or date_bin(v_step, p_ends_at, c_origin) <> p_ends_at then
      raise exception 'Bookings start and end on the %.',
        case when v_role = 'staff' then 'quarter hour' else 'half hour' end
        using errcode = '22023';
    end if;
    if p_starts_at < date_bin(v_step, now(), c_origin) then
      raise exception 'That time has already passed.' using errcode = '22023';
    end if;
  end if;

  -- Limits for non-staff.
  if v_role <> 'staff' and p_starts_at > now() + c_max_advance then
    raise exception 'You can book up to % ahead.', c_max_advance using errcode = '22023';
  end if;
  if v_role = 'student' then
    if p_ends_at - p_starts_at > c_student_max_length then
      raise exception 'Students can book up to 2 hours at a time.' using errcode = '22023';
    end if;
    -- Serialize this user's bookings so two quick clicks can't both pass.
    perform pg_advisory_xact_lock(hashtext('booking:' || v_uid));
    select count(*) into v_upcoming
    from public.bookings b
    where b.booked_for = v_uid and b.status = 'active'
      and b.kind = 'reservation' and b.ends_at > now();
    if v_upcoming >= c_student_max_future then
      raise exception 'You already have an upcoming booking. Cancel it to book another.'
        using errcode = '22023';
    end if;
  end if;

  begin
    insert into public.bookings
      (space_id, starts_at, ends_at, kind, title, booked_for, booked_by, series_id)
    values
      (p_space_id, p_starts_at, p_ends_at, p_kind, v_title, v_for, v_uid, p_series_id)
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'That slot was just taken. Pick another time.' using errcode = '23P01';
  end;

  return v_id;
end
$$;

------------------------------------------------------------------------------
-- create_series: skip closed days; optionally skip past meetings (imports)
------------------------------------------------------------------------------

drop function public.create_series(smallint, public.booking_kind, text, date, date, int[], time, time, boolean);

create function public.create_series(
  p_space_id       smallint,
  p_kind           public.booking_kind,
  p_title          text,
  p_first_day      date,
  p_last_day       date,
  p_weekdays       int[],          -- ISO: 1 = Monday … 5 = Friday
  p_start          time,
  p_end            time,
  p_skip_conflicts boolean default false,
  p_skip_past      boolean default false   -- imports: skip meetings that already started
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_tz        constant text := 'America/Chicago';
  v_series    uuid := gen_random_uuid();
  v_day       date;
  v_s         timestamptz;
  v_e         timestamptz;
  v_matching  int := 0;
  v_past      int := 0;
  v_closed    date[] := '{}';
  v_conflicts date[] := '{}';
  v_free      date[] := '{}';
begin
  if not app.is_staff() then
    raise exception 'Only staff can add classes and sessions.' using errcode = '42501';
  end if;
  if p_kind not in ('class', 'recurring') then
    raise exception 'Series must be a class or recurring session.' using errcode = '22023';
  end if;
  if p_first_day is null or p_last_day is null or p_last_day < p_first_day
     or p_last_day - p_first_day > 180 then
    raise exception 'Pick a date range of up to 180 days.' using errcode = '22023';
  end if;
  if p_weekdays is null or cardinality(p_weekdays) = 0 then
    raise exception 'Pick at least one weekday.' using errcode = '22023';
  end if;

  for v_day in
    select g::date
    from generate_series(p_first_day, p_last_day, interval '1 day') g
    where extract(isodow from g)::int = any (p_weekdays)
    order by 1
  loop
    v_matching := v_matching + 1;
    v_s := (v_day + p_start) at time zone c_tz;
    v_e := (v_day + p_end) at time zone c_tz;
    if exists (select 1 from public.calendar_days c where c.day = v_day and c.kind = 'closed') then
      v_closed := v_closed || v_day;
    elsif p_skip_past and v_s <= now() then          -- already started or over
      v_past := v_past + 1;
    elsif exists (select 1 from public.bookings b
                  where b.space_id = p_space_id and b.status = 'active'
                    and b.during && tstzrange(v_s, v_e, '[)')) then
      v_conflicts := v_conflicts || v_day;
    else
      v_free := v_free || v_day;
    end if;
  end loop;

  if v_matching = 0 then
    raise exception 'No dates match those weekdays.' using errcode = '22023';
  end if;
  if cardinality(v_conflicts) > 0 and not p_skip_conflicts then
    raise exception 'Conflicts on: %', array_to_string(v_conflicts, ', ')
      using errcode = '23P01',
            hint = 'Nothing was added. Retry with "skip conflicts" to add the free dates.';
  end if;

  foreach v_day in array v_free loop
    perform public.create_booking(
      p_space_id,
      (v_day + p_start) at time zone c_tz,
      (v_day + p_end) at time zone c_tz,
      p_kind, p_title, null, v_series);
  end loop;

  return jsonb_build_object(
    'series_id', v_series,
    'created',   cardinality(v_free),
    'skipped',   to_jsonb(v_conflicts),
    'closed',    to_jsonb(v_closed),
    'past',      v_past);
end
$$;

revoke all on function public.create_series(smallint, public.booking_kind, text, date, date, int[], time, time, boolean, boolean) from public, anon;
grant execute on function public.create_series(smallint, public.booking_kind, text, date, date, int[], time, time, boolean, boolean) to authenticated;
