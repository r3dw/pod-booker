-- A photo per space (files in public/spaces/). Pods 206, 207 and 215 use the
-- Pod 216 photo until each has its own.
alter table public.spaces add column photo_url text;

update public.spaces set photo_url = '/spaces/room-208.jpg' where name = 'Room 208';
update public.spaces set photo_url = '/spaces/room-213.jpg' where name = 'Room 213';
update public.spaces set photo_url = '/spaces/pod-216.jpg'  where kind = 'pod';
