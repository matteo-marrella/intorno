-- Intorno: schema iniziale. Eseguire nel SQL editor del progetto Supabase `intorno`.

create table public.allowed_emails (
  email text primary key,
  is_admin boolean not null default false
);

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table public.room_messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index on public.room_messages (room_id, created_at desc);

-- Team chiuso: true se l'utente loggato è in allowed_emails.
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- Blocca la registrazione di email non in lista.
create or replace function public.enforce_allowed_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.allowed_emails where lower(email) = lower(new.email)) then
    raise exception 'Email non autorizzata';
  end if;
  return new;
end $$;

create trigger before_signup_check before insert on auth.users
  for each row execute function public.enforce_allowed_email();

-- Crea il profilo alla registrazione.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, initcap(split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger after_signup_profile after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS
alter table public.allowed_emails enable row level security;
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_messages enable row level security;

create policy "allowed_emails: vedi la tua riga" on public.allowed_emails
  for select to authenticated using (lower(email) = lower(auth.jwt() ->> 'email'));

create policy "profiles: lettura membri" on public.profiles
  for select to authenticated using (public.is_member());
create policy "profiles: modifica il tuo" on public.profiles
  for update to authenticated using (id = auth.uid() and public.is_member())
  with check (id = auth.uid());

create policy "rooms: lettura membri" on public.rooms
  for select to authenticated using (public.is_member());

create policy "messages: lettura membri" on public.room_messages
  for select to authenticated using (public.is_member());
create policy "messages: scrive il proprietario" on public.room_messages
  for insert to authenticated with check (user_id = auth.uid() and public.is_member());

alter publication supabase_realtime add table public.room_messages;

-- Dati iniziali: sostituisci con le email del team.
insert into public.rooms (name, sort) values ('Generale', 0), ('Studio', 1), ('Focus', 2);
-- insert into public.allowed_emails (email, is_admin) values ('nome@dominio.it', true);
