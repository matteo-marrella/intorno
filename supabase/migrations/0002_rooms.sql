-- Stanze condivise: "Generale" è fissa, tutti i membri possono creare ed eliminare le altre.
alter table public.rooms add column if not exists is_default boolean not null default false;

insert into public.rooms (name, sort, is_default) values ('Generale', -1, true)
on conflict (name) do update set is_default = true, sort = -1;

create unique index if not exists rooms_one_default on public.rooms (is_default) where is_default;
alter table public.rooms drop constraint if exists rooms_name_len;
alter table public.rooms add constraint rooms_name_len check (char_length(name) between 1 and 40);

drop policy if exists "rooms: i membri creano" on public.rooms;
create policy "rooms: i membri creano" on public.rooms
  for insert to authenticated with check (public.is_member() and not is_default);

drop policy if exists "rooms: i membri eliminano" on public.rooms;
create policy "rooms: i membri eliminano" on public.rooms
  for delete to authenticated using (public.is_member() and not is_default);

-- Le nuove stanze compaiono subito a tutti
alter publication supabase_realtime add table public.rooms;
