create schema if not exists valdez;

create table if not exists valdez.guilds (
  guild_id text primary key,
  name text,
  icon_url text,
  member_count int,
  owner_id text,
  voice_channel_id text,
  clips_channel_id text,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  last_seen_at timestamptz
);

create table if not exists valdez.licenses (
  guild_id text primary key references valdez.guilds(guild_id) on delete cascade,
  plan text not null default 'trial',
  status text not null default 'active',
  price_cents int not null default 0,
  founder boolean not null default false,
  started_at timestamptz not null default now(),
  expires_at timestamptz,
  external_ref text,
  note text,
  updated_at timestamptz not null default now(),
  constraint licenses_plan_check check (plan in ('trial', 'basic', 'pro', 'max')),
  constraint licenses_status_check check (status in ('active', 'expired', 'canceled'))
);

create table if not exists valdez.events (
  id bigserial primary key,
  guild_id text not null,
  kind text not null,
  user_id text,
  seconds int,
  bytes int,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists events_guild_created_idx on valdez.events (guild_id, created_at desc);
create index if not exists events_kind_created_idx on valdez.events (kind, created_at desc);

create table if not exists valdez.feedback (
  id bigserial primary key,
  guild_id text not null,
  guild_name text,
  user_id text not null,
  username text,
  rating int,
  message text not null,
  handled boolean not null default false,
  created_at timestamptz not null default now(),
  constraint feedback_rating_check check (rating is null or rating between 1 and 5)
);

create table if not exists valdez.payments (
  id bigserial primary key,
  guild_id text not null,
  amount_cents int not null,
  method text not null default 'manual',
  external_ref text,
  note text,
  paid_at timestamptz not null default now()
);

create index if not exists payments_paid_at_idx on valdez.payments (paid_at desc);

create table if not exists valdez.heartbeats (
  id bigserial primary key,
  guilds int not null,
  connected int not null,
  buffering int not null default 0,
  uptime_seconds int,
  version text,
  at timestamptz not null default now()
);

create index if not exists heartbeats_at_idx on valdez.heartbeats (at desc);

-- Quem enxerga o painel. Vazio = ninguém lê nada, nem autenticado.
create table if not exists valdez.admins (
  user_id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);

alter table valdez.guilds enable row level security;
alter table valdez.licenses enable row level security;
alter table valdez.events enable row level security;
alter table valdez.feedback enable row level security;
alter table valdez.payments enable row level security;
alter table valdez.heartbeats enable row level security;
alter table valdez.admins enable row level security;

create or replace function valdez.is_admin()
returns boolean
language sql
stable
security definer
set search_path = valdez, pg_temp
as $$
  select exists (select 1 from valdez.admins a where a.user_id = auth.uid());
$$;

revoke all on function valdez.is_admin() from public, anon;
grant execute on function valdez.is_admin() to authenticated;

-- Default-deny: sem policy de insert/update/delete, só o service_role (que
-- ignora RLS) escreve. O painel é estritamente leitura.
do $$
declare t text;
begin
  foreach t in array array['guilds', 'licenses', 'events', 'feedback', 'payments', 'heartbeats']
  loop
    execute format('drop policy if exists admin_read on valdez.%I', t);
    execute format(
      'create policy admin_read on valdez.%I for select to authenticated using (valdez.is_admin())', t
    );
  end loop;
end $$;

drop policy if exists admin_self on valdez.admins;
create policy admin_self on valdez.admins
  for select to authenticated using (user_id = auth.uid());

revoke all on all tables in schema valdez from anon;
grant usage on schema valdez to authenticated, service_role;
grant select on all tables in schema valdez to authenticated;
grant all on all tables in schema valdez to service_role;
grant usage, select on all sequences in schema valdez to service_role;
