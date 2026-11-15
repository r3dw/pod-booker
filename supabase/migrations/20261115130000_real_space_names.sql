-- Real room numbers and capacities (decision #5).
-- Matched by function: the instructor+staff room is 208, the staff-only room is 213.
-- Rooms seat about 8, pods about 5.
update public.spaces set name = 'Room 208', capacity = 8 where id = 1 and bookable_by = '{instructor,staff}';
update public.spaces set name = 'Room 213', capacity = 8 where id = 2 and bookable_by = '{staff}';
update public.spaces set name = 'Pod 206',  capacity = 5 where id = 3;
update public.spaces set name = 'Pod 207',  capacity = 5 where id = 4;
update public.spaces set name = 'Pod 215',  capacity = 5 where id = 5;
update public.spaces set name = 'Pod 216',  capacity = 5 where id = 6;
