-- RLS, privacy, and booking-rule tests. Run with: scripts/db.sh test
-- Everything happens inside one transaction that is rolled back at the end,
-- so the real database is untouched. Any failure stops the run with "FAIL: …".

\pset tuples_only on
\pset format unaligned

begin;

------------------------------------------------------------------------------
-- Test helpers and fixtures (as the postgres owner)
------------------------------------------------------------------------------

create schema tests;
grant usage on schema tests to authenticated, anon;

-- Next weekday strictly after today (Chicago), and a weekday in the past.
create function tests.day(offset_days int default 0) returns date language sql stable as $$
  select d::date from generate_series(
           (now() at time zone 'America/Chicago')::date + 1 + offset_days,
           (now() at time zone 'America/Chicago')::date + 10 + offset_days, interval '1 day') d
  where extract(isodow from d) between 1 and 5 order by d limit 1
$$;
create function tests.past_day() returns date language sql stable as $$
  select d::date from generate_series(
           (now() at time zone 'America/Chicago')::date - 7,
           (now() at time zone 'America/Chicago')::date - 1, interval '1 day') d
  where extract(isodow from d) between 1 and 5 order by d desc limit 1
$$;
-- A Chicago wall-clock time on tests.day().
create function tests.at(h int, m int default 0, d date default null) returns timestamptz
language sql stable as $$
  select (coalesce(d, tests.day()) + make_time(h, m, 0)) at time zone 'America/Chicago'
$$;

-- Act as a signed-in Clerk user (what the Supabase Clerk integration does per request).
create function tests.login(sub text, email text default null) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', sub, 'role', 'authenticated', 'email', email)::text, true)
$$;

create function tests.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;

create function tests.fails(stmt text, pattern text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'FAIL: % (no error from: %)', msg, stmt;
exception when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
  if sqlerrm !~* pattern then
    raise exception 'FAIL: % (got "%", expected /%/)', msg, sqlerrm, pattern;
  end if;
  raise notice 'ok - %', msg;
end $$;

grant execute on all functions in schema tests to authenticated, anon;

insert into public.profiles (id, email, role) values
  ('t_sa',    'sa@uchicago.edu',    'student'),
  ('t_sb',    'sb@uchicago.edu',    'student'),
  ('t_inst',  'inst@uchicago.edu',  'instructor'),
  ('t_staff', 'staff@uchicago.edu', 'staff');

------------------------------------------------------------------------------
-- Anonymous: nothing
------------------------------------------------------------------------------

set local role anon;
select tests.fails('select * from public.spaces',          'permission denied', 'anon cannot read spaces');
select tests.fails('select * from public.calendar_public', 'permission denied', 'anon cannot read calendar');
select tests.fails('select * from public.bookings',        'permission denied', 'anon cannot read bookings');
select tests.fails($$select public.create_booking(3::smallint, now(), now() + interval '1 hour')$$,
                   'permission denied', 'anon cannot call create_booking');

------------------------------------------------------------------------------
-- Profiles: uchicago.edu only, enforced in the database
------------------------------------------------------------------------------

set local role authenticated;

select tests.login('t_new', 'someone@gmail.com');
select tests.fails('select public.ensure_profile()', 'uchicago\.edu', 'non-uchicago email cannot create a profile');
select tests.login('t_new', 'someone@cs.uchicago.edu.evil.com');
select tests.fails('select public.ensure_profile()', 'uchicago\.edu', 'look-alike domain rejected');
select tests.login('t_new', null);
select tests.fails('select public.ensure_profile()', 'email claim', 'token without email claim rejected');
select tests.login('t_new', 'New@UChicago.edu');
select tests.ok((select role = 'student' and email = 'new@uchicago.edu' from public.ensure_profile()),
                'first sign-in creates a student profile (email lower-cased)');
select tests.ok((select role = 'student' from public.ensure_profile()), 'ensure_profile is idempotent');

------------------------------------------------------------------------------
-- Student A books; rules
------------------------------------------------------------------------------

select tests.login('t_sa');
select tests.ok(public.create_booking(3::smallint, tests.at(10), tests.at(11)) is not null,
                'student books Pod 1 for 1 h');
select tests.fails($$select public.create_booking(4::smallint, tests.at(13), tests.at(14))$$,
                   'already have an upcoming', 'student limited to 1 upcoming booking');
select tests.fails($$insert into public.bookings (space_id, starts_at, ends_at, kind, booked_by)
                     values (4, tests.at(13), tests.at(14), 'reservation', 't_sa')$$,
                   'permission denied', 'student cannot insert into bookings directly');
select tests.fails($$update public.bookings set ends_at = ends_at + interval '3 hours'$$,
                   'permission denied', 'student cannot update bookings directly');

select tests.login('t_sb');
select tests.fails($$select public.create_booking(2::smallint, tests.at(10), tests.at(11))$$,
                   'can''t be booked', 'student cannot book staff-only Room B via RPC');
select tests.fails($$select public.create_booking(1::smallint, tests.at(10), tests.at(11))$$,
                   'can''t be booked', 'student cannot book instructor room A via RPC');
select tests.fails($$select public.create_booking(4::smallint, tests.at(9), tests.at(12))$$,
                   '2 hours', 'student max 2 h');
select tests.fails($$select public.create_booking(4::smallint, tests.at(10, 15), tests.at(11, 15))$$,
                   'half hour', 'bookings on the half-hour grid');
select tests.fails($$select public.create_booking(4::smallint, tests.at(8), tests.at(9))$$,
                   'Monday–Friday, 8:30', 'no booking before 8:30');
select tests.fails($$select public.create_booking(4::smallint, tests.at(16, 30), tests.at(17, 30))$$,
                   'Monday–Friday, 8:30', 'no booking past 5:00');
select tests.fails($$select public.create_booking(4::smallint,
                       tests.at(10, 0, tests.day() + (6 - extract(isodow from tests.day())::int)),
                       tests.at(11, 0, tests.day() + (6 - extract(isodow from tests.day())::int)))$$,
                   'Monday–Friday', 'no weekend bookings');
select tests.fails($$select public.create_booking(4::smallint, tests.at(10, 0, tests.past_day()),
                                                   tests.at(11, 0, tests.past_day()))$$,
                   'already passed', 'no booking in the past');
select tests.fails($$select public.create_booking(4::smallint, tests.at(10, 0, tests.day(8)),
                                                   tests.at(11, 0, tests.day(8)))$$,
                   'ahead', 'no booking more than 7 days ahead');
select tests.fails($$select public.create_booking(3::smallint, tests.at(10, 30), tests.at(11, 30))$$,
                   'just taken', 'overlapping booking rejected (exclusion constraint)');
select tests.fails($$select public.create_booking(4::smallint, tests.at(13), tests.at(14), 'class', 'Fake class')$$,
                   'Only staff', 'student cannot create a class');
select tests.fails($$select public.create_booking(4::smallint, tests.at(13), tests.at(14), 'reservation', null, 't_sa')$$,
                   'Only staff', 'student cannot book for someone else');
select tests.fails($$select public.set_user_role('t_sb', 'staff')$$,
                   'Only staff', 'student cannot promote themselves');

------------------------------------------------------------------------------
-- Privacy: student B can't see who booked, by any route
------------------------------------------------------------------------------

select tests.ok((select count(*) = 0 from public.bookings), 'student B sees none of A''s rows in bookings');
select tests.ok((select count(*) = 1 from public.profiles), 'student sees only their own profile');
select tests.ok((select title = 'Booked' and not is_mine from public.calendar_public where space_id = 3),
                'calendar shows A''s booking as "Booked", not mine');
select tests.ok(not exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'calendar_public'
                              and column_name in ('booked_for', 'booked_by', 'email', 'display_name')),
                'calendar_public has no identity columns');
select tests.fails($$select public.cancel_booking((select id from public.calendar_public where space_id = 3))$$,
                   'not found', 'student cannot cancel someone else''s booking');

-- No profile = nothing (e.g. a non-uchicago Clerk account).
select tests.login('t_ghost', 'ghost@uchicago.edu');
select tests.ok((select count(*) = 0 from public.calendar_public), 'user without profile sees an empty calendar');
select tests.fails($$select public.create_booking(4::smallint, tests.at(13), tests.at(14))$$,
                   'no profile', 'user without profile cannot book');

-- A cancels own booking, then can book again.
select tests.login('t_sa');
select tests.ok((select is_mine from public.calendar_public where space_id = 3), 'owner sees is_mine');
select public.cancel_booking((select id from public.bookings where booked_for = 't_sa'));
select tests.ok((select count(*) = 0 from public.calendar_public where space_id = 3), 'cancelled booking leaves the calendar');
select tests.ok(public.create_booking(3::smallint, tests.at(10), tests.at(12)) is not null,
                'after cancelling, student can book again (2 h)');

------------------------------------------------------------------------------
-- Instructor
------------------------------------------------------------------------------

select tests.login('t_inst');
select tests.ok(public.create_booking(1::smallint, tests.at(9), tests.at(11, 30)) is not null,
                'instructor books Room A for 2.5 h');
select tests.fails($$select public.create_booking(2::smallint, tests.at(13), tests.at(14))$$,
                   'can''t be booked', 'instructor cannot book staff-only Room B');

------------------------------------------------------------------------------
-- Staff
------------------------------------------------------------------------------

select tests.login('t_staff');
select tests.ok((select count(*) = 3 from public.bookings), 'staff see all bookings, including cancelled');
select tests.ok((select count(*) = 2 from public.bookings where status = 'active'), 'two active bookings so far');
select tests.ok((select count(*) >= 5 from public.profiles), 'staff see all profiles');
select public.create_booking(4::smallint, tests.at(13), tests.at(14), 'reservation', null, 't_sb') as onbehalf_id \gset
select tests.ok((select booked_for = 't_sb' and booked_by = 't_staff' from public.bookings where id = :'onbehalf_id'),
                'staff book on behalf of a student');
select tests.fails($$select public.create_booking(3::smallint, tests.at(11), tests.at(12))$$,
                   'just taken', 'staff cannot double-book either');
select tests.ok(public.create_booking(2::smallint, tests.at(13), tests.at(16)) is not null,
                'staff book Room B for 3 h');

-- Series: conflict reported, nothing inserted; then skip conflicts.
select tests.fails(format($$select public.create_series(1::smallint, 'class', 'MPCS 51238', %L, %L, '{%s}', '10:00', '11:00')$$,
                          tests.day(), tests.day() + 14, extract(isodow from tests.day())::int),
                   'Conflicts on', 'series conflicting with a booking is rejected');
select tests.ok((select count(*) = 0 from public.bookings where title = 'MPCS 51238'),
                'rejected series inserted nothing');
select tests.ok((select (r ->> 'created')::int >= 2 and jsonb_array_length(r -> 'skipped') = 1
                 from public.create_series(1::smallint, 'class', 'MPCS 51238', tests.day(), tests.day() + 14,
                                           array[extract(isodow from tests.day())::int], '10:00', '11:00', true) r),
                'series with skip_conflicts inserts the free dates and lists the conflict');

select tests.login('t_sb');
select tests.ok((select bool_and(title = 'MPCS 51238') from public.calendar_public where kind = 'class'),
                'students see class names');

select tests.login('t_staff');
select tests.ok(public.cancel_series((select series_id from public.bookings where title = 'MPCS 51238' limit 1)) >= 2,
                'staff cancel a series');
select public.set_user_role('t_new', 'instructor');
select tests.ok((select role = 'instructor' from public.profiles where id = 't_new'), 'staff promote a user');
select tests.fails($$select public.set_user_role('t_staff', 'student')$$,
                   'own staff role', 'staff cannot demote themselves');

-- Walk-in only testable during open hours.
do $$
begin
  if extract(isodow from now() at time zone 'America/Chicago') between 1 and 5
     and (now() at time zone 'America/Chicago')::time between '08:30' and '16:30' then
    perform tests.ok(public.staff_walkin(6::smallint, 't_sb', 60, null) is not null, 'staff log a walk-in');
  else
    raise notice 'skip - walk-in test (outside open hours)';
  end if;
end $$;

------------------------------------------------------------------------------
-- Realtime payload carries no names; raw constraint holds even for the owner
------------------------------------------------------------------------------

reset role;

select tests.ok(exists (select 1 from pg_trigger where tgname = 'bookings_broadcast'
                        and tgrelid = 'public.bookings'::regclass), 'broadcast trigger installed');
do $$
begin
  if exists (select 1 from pg_inherits where inhparent = 'realtime.messages'::regclass) then
    perform tests.ok(
      not exists (select 1 from realtime.messages
                  where topic = 'calendar'
                    and (select array_agg(k order by k) from jsonb_object_keys(payload) k) <> '{day,id,space_id}'),
      'broadcast payloads contain only space_id, day, id');
  else
    raise notice 'skip - realtime payload check (no messages partition yet; Realtime creates it)';
  end if;
end $$;

select tests.fails($$insert into public.bookings (space_id, starts_at, ends_at, kind, booked_by)
                     values (3, tests.at(10), tests.at(11), 'walkin', 't_staff')$$,
                   'bookings_no_overlap', 'exclusion constraint blocks overlaps even for direct inserts');

\echo 'All tests passed.'
rollback;
