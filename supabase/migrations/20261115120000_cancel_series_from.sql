-- Staff can cancel "this and later dates" of a series, not only "everything from now".
-- p_from defaults to now(), so existing one-argument calls behave as before.
-- Dates that have already ended are never touched.

drop function public.cancel_series(uuid);

create function public.cancel_series(p_series_id uuid, p_from timestamptz default null)
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
   where series_id = p_series_id
     and status = 'active'
     and starts_at >= coalesce(p_from, now())
     and ends_at > now();
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

revoke all on function public.cancel_series(uuid, timestamptz) from public, anon;
grant execute on function public.cancel_series(uuid, timestamptz) to authenticated;
