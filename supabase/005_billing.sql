-- Cobrança recorrente por Pix Automático (Woovi).
--
-- O webhook não fala com o bot: ele escreve a licença aqui e o bot pega no
-- pullLicenses, que já roda de minuto em minuto. Isso evita expor a VPS na
-- internet e tira o domínio do caminho crítico do pagamento.

create table if not exists valdez.subscriptions (
  id bigserial primary key,
  guild_id text not null references valdez.guilds(guild_id) on delete cascade,
  plan text not null,
  -- correlationID que vai pra Woovi e volta no webhook. É a única coisa que
  -- amarra o dinheiro que chegou ao servidor que deve ser liberado.
  correlation_id text not null unique,
  woovi_subscription_id text,
  status text not null default 'pending',
  price_cents int not null,
  founder boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_plan_check check (plan in ('basic', 'pro', 'max', 'lifetime')),
  constraint subscriptions_status_check check (status in ('pending', 'active', 'canceled'))
);

create index if not exists subscriptions_guild_idx on valdez.subscriptions (guild_id);

alter table valdez.subscriptions enable row level security;

drop policy if exists admin_read on valdez.subscriptions;
create policy admin_read on valdez.subscriptions
  for select to authenticated using (valdez.is_admin());

grant select on valdez.subscriptions to authenticated;
grant all on valdez.subscriptions to service_role;
grant usage, select on all sequences in schema valdez to service_role;

-- Idempotência do webhook: a Woovi reentrega o mesmo evento quando não recebe
-- 200. Sem isso, uma reentrega empilharia +31 dias de licença de graça.
create table if not exists valdez.webhook_events (
  provider_event_id text primary key,
  received_at timestamptz not null default now()
);

alter table valdez.webhook_events enable row level security;
grant all on valdez.webhook_events to service_role;

-- A landing mostra quantas vagas de fundador sobraram e é chamada por anônimo.
-- Devolve só um número: nenhum dado de servidor ou de cliente sai daqui.
-- SECURITY DEFINER porque o anon não lê valdez.licenses (e não deve mesmo).
create or replace function valdez.founder_slots_left()
returns int
language sql
stable
security definer
set search_path = valdez, pg_temp
as $$
  select greatest(
    0,
    100 - (
      select count(*)::int
      from valdez.licenses
      where founder and status = 'active' and plan <> 'owner'
    )
  );
$$;

revoke all on function valdez.founder_slots_left() from public;
grant execute on function valdez.founder_slots_left() to anon, authenticated;

-- Os servidores de quem está logado, pra tela de assinatura escolher qual pagar.
-- A RLS de valdez.guilds é só admin, então sem isto o dono não enxerga nem o
-- próprio servidor. O filtro é o provider_id do Discord dentro do próprio JWT:
-- não dá pra pedir servidor alheio porque o WHERE não aceita parâmetro.
create or replace function valdez.my_guilds()
returns table (
  guild_id text,
  name text,
  icon_url text,
  plan text,
  status text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = valdez, pg_temp
as $$
  select g.guild_id, g.name, g.icon_url, l.plan, l.status, l.expires_at
  from valdez.guilds g
  left join valdez.licenses l on l.guild_id = g.guild_id
  where g.left_at is null
    and g.owner_id = (auth.jwt() -> 'user_metadata' ->> 'provider_id')
  order by g.name;
$$;

revoke all on function valdez.my_guilds() from public, anon;
grant execute on function valdez.my_guilds() to authenticated;
