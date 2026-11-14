-- Day 1: schema, seed, and an auth check.
-- RLS is enabled on every table now. Only `spaces` gets a read policy today;
-- the rest stay deny-all until the role helper and policies land on day 2.

create extension if not exists btree_gist;

create type public.user_role      as enum ('student', 'instructor', 'staff');
create type public.space_kind     as enum ('room', 'pod');
create type public.booking_kind   as enum ('class', 'recurring', 'reservation', 'walkin');
create type public.booking_status as enum ('active', 'cancelled');

create table public.profiles (
  id            text primary key,                        -- Clerk user id
  email         text unique not null
                check (lower(email) like '%@uchicago.edu'),
  display_name  text,
  role          public.user_role not null default 'student',
  created_at    timestamptz not null default now()
);

create table public.spaces (
  id           smallint primary key,
  name         text not null unique,
  kind         public.space_kind not null,
  capacity     smallint not null check (capacity > 0),
  bookable_by  public.user_role[] not null,
  active       boolean not null default true
);

create table public.bookings (
  id          uuid primary key default gen_random_uuid(),
  space_id    smallint not null references public.spaces,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  during      tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,
  kind        public.booking_kind not null,
  title       text,                                       -- class / session name; null for personal
  booked_for  text references public.profiles,            -- null for classes
  booked_by   text not null references public.profiles,
  series_id   uuid,                                       -- groups rows from one recurring entry / CSV row
  status      public.booking_status not null default 'active',
  created_at  timestamptz not null default now(),
  constraint bookings_time_order check (ends_at > starts_at),
  constraint bookings_no_overlap
    exclude using gist (space_id with =, during with &&) where (status = 'active')
);

create index bookings_starts_at_idx on public.bookings (starts_at);
create index bookings_booked_for_idx on public.bookings (booked_for);
create index bookings_series_idx on public.bookings (series_id) where series_id is not null;

-- RLS on everything. No policy = no access (except service role).
alter table public.profiles enable row level security;
alter table public.spaces   enable row level security;
alter table public.bookings enable row level security;

-- Table privileges are granted explicitly (the project has "auto-expose new
-- tables" off). Anonymous users get nothing, ever: login-only app.
-- profiles/bookings get their grants with the day-2 policies and RPCs.
revoke all on public.profiles, public.spaces, public.bookings from anon, authenticated;
grant select on public.spaces to authenticated;

create policy "signed-in users read spaces"
  on public.spaces for select to authenticated
  using (true);

-- Auth check used by the day-1 page: returns what Postgres sees in the JWT.
create function public.whoami()
returns json
language sql
stable
as $$
  select json_build_object(
    'sub',  auth.jwt() ->> 'sub',
    'role', auth.jwt() ->> 'role'
  )
$$;
revoke execute on function public.whoami() from public, anon;
grant  execute on function public.whoami() to authenticated;

-- Seed. Names and capacities are placeholders until decision #5 is settled.
insert into public.spaces (id, name, kind, capacity, bookable_by) values
  (1, 'Room A', 'room', 8, '{instructor,staff}'),
  (2, 'Room B', 'room', 8, '{staff}'),
  (3, 'Pod 1',  'pod',  2, '{student,instructor,staff}'),
  (4, 'Pod 2',  'pod',  2, '{student,instructor,staff}'),
  (5, 'Pod 3',  'pod',  2, '{student,instructor,staff}'),
  (6, 'Pod 4',  'pod',  2, '{student,instructor,staff}');
