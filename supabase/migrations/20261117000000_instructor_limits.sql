-- Booking limits for instructors (security review, Nov 17).
--
-- Before: only students had a length cap and an "upcoming at once" limit, so
-- one instructor could book every pod and Room 208 for a whole week.
-- Now: instructors book up to 3 hours at a time, with at most 3 upcoming
-- reservations. Students are unchanged (2 hours, 1 upcoming). Staff have no
-- limits, and bookings staff make for someone aren't counted against limits
-- at booking time (they do count toward that person's own next booking).
-- The rest of create_booking is unchanged from 20261116120000.

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
  c_student_max_future constant int      := 1;          -- upcoming reservations at once
  c_instr_max_length   constant interval := '3 hours';
  c_instr_max_future   constant int      := 3;
  c_max_advance        constant interval := '7 days';   -- students + instructors
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
  v_max_len  interval;
  v_max_fut  int;
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
  -- Length and "upcoming at once" limits for students and instructors.
  -- (Staff booking on someone's behalf are checked as staff, so not limited.)
  if v_role in ('student', 'instructor') then
    if v_role = 'student' then
      v_max_len := c_student_max_length;
      v_max_fut := c_student_max_future;
    else
      v_max_len := c_instr_max_length;
      v_max_fut := c_instr_max_future;
    end if;
    if p_ends_at - p_starts_at > v_max_len then
      raise exception '%s can book up to % hours at a time.',
        initcap(v_role::text), extract(epoch from v_max_len)::int / 3600
        using errcode = '22023';
    end if;
    -- Serialize this user's bookings so two quick clicks can't both pass.
    perform pg_advisory_xact_lock(hashtext('booking:' || v_uid));
    select count(*) into v_upcoming
    from public.bookings b
    where b.booked_for = v_uid and b.status = 'active'
      and b.kind = 'reservation' and b.ends_at > now();
    if v_upcoming >= v_max_fut then
      raise exception '%', case when v_max_fut = 1
        then 'You already have an upcoming booking. Cancel it to book another.'
        else format('You already have %s upcoming bookings. Cancel one to book another.', v_max_fut) end
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
