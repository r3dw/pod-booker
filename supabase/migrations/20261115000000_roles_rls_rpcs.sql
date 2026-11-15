-- Day 2: profiles, roles, RLS policies, the name-free calendar view,
-- the realtime broadcast, and the booking RPCs.
--
-- Security model
-- - Signed-in users read only what RLS allows. They never write tables
--   directly; every write goes through a SECURITY DEFINER function below
--   that checks the caller's role and the booking rules.
-- - A user only counts as a user once they have a profile, and a profile can
--   only be created for an @uchicago.edu email taken from the signed Clerk
--   token. No profile = sees nothing, books nothing.
-- - Students read other people's bookings only through calendar_public,
--   which has no name columns.

------------------------------------------------------------------------------
-- Private helpers (schema `app` is not exposed through the Data API)
------------------------------------------------------------------------------

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated;

-- Clerk user id of the caller, from the verified JWT.
create function app.uid()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'sub', '')
$$;

-- Caller's role, or null if they have no profile.
-- SECURITY DEFINER so policies on `profiles` can use it without recursion.
create function app.my_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = app.uid()
$$;

create function app.is_staff()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(app.my_role() = 'staff', false)
$$;

revoke all on function app.uid(), app.my_role(), app.is_staff() from public;
grant execute on function app.uid(), app.my_role(), app.is_staff() to authenticated;

------------------------------------------------------------------------------
-- Profiles
------------------------------------------------------------------------------

grant select on public.profiles to authenticated;

create policy "read own profile; staff read all"
  on public.profiles for select to authenticated
  using (id = (select app.uid()) or (select app.is_staff()));

-- Called on every signed-in page load. Creates the profile on first sign-in.
-- Email comes from the signed Clerk token (custom `email` claim), never from
-- the client, so it can't be spoofed.
create function public.ensure_profile()
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      text := app.uid();
  v_email   text := lower(nullif(btrim(auth.jwt() ->> 'email'), ''));
  v_name    text := nullif(btrim(auth.jwt() ->> 'name'), '');
  v_profile public.profiles;
begin
  if v_id is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;
  if v_email is null then
    raise exception 'Sign-in token has no email claim (check the Clerk session token settings).'
      using errcode = '28000';
  end if;
  if v_email !~ '^[^@\s]+@uchicago\.edu$' then
    raise exception 'Only @uchicago.edu accounts can use this app.' using errcode = '42501';
  end if;

  insert into public.profiles (id, email, display_name)
  values (v_id, v_email, v_name)
  on conflict (id) do update
    set email        = excluded.email,
        display_name = coalesce(excluded.display_name, public.profiles.display_name)
  returning * into v_profile;

  return v_profile;
end
$$;

-- Staff promote/demote users. Everyone starts as student.
create function public.set_user_role(p_user_id text, p_role public.user_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_staff() then
    raise exception 'Only staff can change roles.' using errcode = '42501';
  end if;
  if p_user_id = app.uid() and p_role <> 'staff' then
    raise exception 'You can''t remove your own staff role.' using errcode = '42501';
  end if;
  update public.profiles set role = p_role where id = p_user_id;
  if not found then
    raise exception 'No such user.' using errcode = 'P0002';
  end if;
end
$$;

------------------------------------------------------------------------------
-- Bookings: read access
------------------------------------------------------------------------------

grant select on public.bookings to authenticated;

create policy "read own bookings; staff read all"
  on public.bookings for select to authenticated
  using (booked_for = (select app.uid()) or (select app.is_staff()));

-- What students and instructors see for everyone's bookings: when and where,
-- the class/session name for classes, and just "Booked" for personal ones.
-- No booked_for / booked_by columns, so names can't leak.
-- Runs with the owner's rights on purpose (not security_invoker), because it
-- has to show slots the caller can't read in `bookings`.
create view public.calendar_public as
select
  b.id,
  b.space_id,
  b.starts_at,
  b.ends_at,
  b.kind,
  case when b.kind in ('class', 'recurring') then b.title else 'Booked' end as title,
  coalesce(b.booked_for = (select app.uid()), false) as is_mine
from public.bookings b
where b.status = 'active'
  and (select app.my_role()) is not null;   -- no profile, no calendar

revoke all on public.calendar_public from anon, authenticated;
grant select on public.calendar_public to authenticated;

------------------------------------------------------------------------------
-- Realtime: a name-free "something changed" broadcast
------------------------------------------------------------------------------

-- Sends {space_id, day} on the private `calendar` topic. Clients refetch that
-- day from calendar_public (or bookings, for staff). No titles, no names.
create function app.broadcast_booking_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform realtime.send(
      jsonb_build_object(
        'space_id', new.space_id,
        'day', (new.starts_at at time zone 'America/Chicago')::date),
      'booking_changed', 'calendar', true);
  end if;
  if tg_op = 'DELETE'
     or (tg_op = 'UPDATE'
         and (old.space_id, (old.starts_at at time zone 'America/Chicago')::date)
             is distinct from
             (new.space_id, (new.starts_at at time zone 'America/Chicago')::date)) then
    perform realtime.send(
      jsonb_build_object(
        'space_id', old.space_id,
        'day', (old.starts_at at time zone 'America/Chicago')::date),
      'booking_changed', 'calendar', true);
  end if;
  return null;
end
$$;
revoke all on function app.broadcast_booking_change() from public;

create trigger bookings_broadcast
  after insert or update or delete on public.bookings
  for each row execute function app.broadcast_booking_change();

-- Only signed-in users with a profile may listen on the private topic.
create policy "profiled users receive calendar broadcasts"
  on realtime.messages for select to authenticated
  using (
    realtime.topic() = 'calendar'
    and extension = 'broadcast'
    and (select app.my_role()) is not null
  );

------------------------------------------------------------------------------
-- Booking RPCs
------------------------------------------------------------------------------

create function public.create_booking(
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
  c_step               constant interval := '30 minutes';
  c_student_max_length constant interval := '2 hours';
  c_max_advance        constant interval := '7 days';   -- students + instructors
  c_student_max_future constant int      := 1;          -- upcoming reservations at once
  c_origin             constant timestamptz := '2000-01-01 00:00:00+00';

  v_uid      text := app.uid();
  v_role     public.user_role := app.my_role();
  v_space    public.spaces;
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

  -- Time grid and past. Walk-ins start "now", so they skip the grid.
  if p_ends_at <= now() then
    raise exception 'That time has already passed.' using errcode = '22023';
  end if;
  if p_kind <> 'walkin' then
    if date_bin(c_step, p_starts_at, c_origin) <> p_starts_at
       or date_bin(c_step, p_ends_at, c_origin) <> p_ends_at then
      raise exception 'Bookings start and end on the half hour.' using errcode = '22023';
    end if;
    if p_starts_at < date_bin(c_step, now(), c_origin) then
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

-- Desk shortcut: this space, from now until +N minutes, cut short at the next
-- booking or closing time. p_booked_for may be null for walk-ups without an
-- account; p_note (staff-only, shown as "Booked" to students) can hold a name.
create function public.staff_walkin(
  p_space_id   smallint,
  p_booked_for text default null,
  p_minutes    int default 60,
  p_note       text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz := date_trunc('minute', now());
  v_end   timestamptz;
  v_next  timestamptz;
begin
  if not app.is_staff() then
    raise exception 'Only staff can log walk-ins.' using errcode = '42501';
  end if;
  if p_minutes is null or p_minutes not between 5 and 480 then
    raise exception 'Walk-in length must be 5–480 minutes.' using errcode = '22023';
  end if;

  if exists (select 1 from public.bookings b
             where b.space_id = p_space_id and b.status = 'active'
               and b.during @> v_start) then
    raise exception 'That space is in use right now.' using errcode = '23P01';
  end if;

  select min(b.starts_at) into v_next
  from public.bookings b
  where b.space_id = p_space_id and b.status = 'active' and b.starts_at > v_start;

  v_end := least(
    v_start + make_interval(mins => p_minutes),
    coalesce(v_next, 'infinity'),
    ((v_start at time zone 'America/Chicago')::date + time '17:00') at time zone 'America/Chicago');

  return public.create_booking(p_space_id, v_start, v_end, 'walkin', p_note, p_booked_for);
end
$$;

-- Staff: a class or recurring session on chosen weekdays between two dates,
-- expanded into one row per occurrence sharing a series_id.
-- Conflicts are reported, never silently dropped: by default nothing is
-- inserted if any occurrence conflicts; with p_skip_conflicts the free ones
-- are inserted and the conflicting dates are returned.
create function public.create_series(
  p_space_id       smallint,
  p_kind           public.booking_kind,
  p_title          text,
  p_first_day      date,
  p_last_day       date,
  p_weekdays       int[],          -- ISO: 1 = Monday … 5 = Friday
  p_start          time,
  p_end            time,
  p_skip_conflicts boolean default false
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
    v_s := (v_day + p_start) at time zone c_tz;
    v_e := (v_day + p_end) at time zone c_tz;
    if exists (select 1 from public.bookings b
               where b.space_id = p_space_id and b.status = 'active'
                 and b.during && tstzrange(v_s, v_e, '[)')) then
      v_conflicts := v_conflicts || v_day;
    else
      v_free := v_free || v_day;
    end if;
  end loop;

  if cardinality(v_free) + cardinality(v_conflicts) = 0 then
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
    'skipped',   to_jsonb(v_conflicts));
end
$$;

-- Owner cancels their own upcoming booking; staff cancel anything.
create function public.cancel_booking(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b public.bookings;
begin
  select * into v_b from public.bookings where id = p_id for update;
  if not found or not (app.is_staff() or v_b.booked_for = app.uid()) then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;
  if v_b.status = 'cancelled' then
    return;
  end if;
  if not app.is_staff() and v_b.ends_at <= now() then
    raise exception 'Past bookings can''t be cancelled.' using errcode = '22023';
  end if;
  update public.bookings set status = 'cancelled' where id = p_id;
end
$$;

-- Staff: cancel the remaining (future) occurrences of a series.
create function public.cancel_series(p_series_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  if not app.is_staff() then
    raise exception 'Only staff can cancel a series.' using errcode = '42501';
  end if;
  update public.bookings
     set status = 'cancelled'
   where series_id = p_series_id and status = 'active' and starts_at > now();
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

------------------------------------------------------------------------------
-- Function privileges: signed-in users only
------------------------------------------------------------------------------

revoke all on function
  public.ensure_profile(),
  public.set_user_role(text, public.user_role),
  public.create_booking(smallint, timestamptz, timestamptz, public.booking_kind, text, text, uuid),
  public.staff_walkin(smallint, text, int, text),
  public.create_series(smallint, public.booking_kind, text, date, date, int[], time, time, boolean),
  public.cancel_booking(uuid),
  public.cancel_series(uuid)
from public, anon;

grant execute on function
  public.ensure_profile(),
  public.set_user_role(text, public.user_role),
  public.create_booking(smallint, timestamptz, timestamptz, public.booking_kind, text, text, uuid),
  public.staff_walkin(smallint, text, int, text),
  public.create_series(smallint, public.booking_kind, text, date, date, int[], time, time, boolean),
  public.cancel_booking(uuid),
  public.cancel_series(uuid)
to authenticated;
