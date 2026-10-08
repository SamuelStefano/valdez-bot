-- O webhook da Woovi reivindicava a trava de idempotência ANTES de gravar a
-- licença e não checava o resultado de nenhuma escrita, devolvendo 200 sempre.
-- Upsert falhou = cliente pagou, licença nunca ligou, Woovi não reentrega e o
-- reprocesso manual é descartado como duplicado.
--
-- Quatro escritas em quatro chamadas PostgREST não têm como ser atômicas, então
-- elas viram UMA função: ou tudo comita (inclusive a trava), ou nada comita e o
-- webhook devolve 5xx pra Woovi reentregar.
--
-- SECURITY INVOKER de propósito: quem chama é o service_role do edge function,
-- que já escreve nessas tabelas. DEFINER aqui só daria privilégio a mais.

create or replace function valdez.apply_woovi_event(
  p_event_id text,
  p_correlation_id text,
  p_kind text,
  p_expires_at timestamptz,
  p_now timestamptz
) returns text
language plpgsql
set search_path = valdez, pg_temp
as $$
declare
  v_sub valdez.subscriptions%rowtype;
begin
  if p_kind not in ('paid', 'canceled') then
    raise exception 'apply_woovi_event: kind inválido %', p_kind;
  end if;

  -- A trava e o trabalho comitam juntos. Numa entrega duplicada concorrente, o
  -- segundo INSERT espera o primeiro comitar e então não insere nada: FOUND
  -- fica falso e o evento é descartado sem repetir a escrita.
  insert into valdez.webhook_events (provider_event_id)
  values (p_event_id)
  on conflict (provider_event_id) do nothing;

  if not found then
    return 'duplicate';
  end if;

  select * into v_sub
  from valdez.subscriptions
  where correlation_id = p_correlation_id
  for update;

  if not found then
    return 'unknown_subscription';
  end if;

  if p_kind = 'canceled' then
    update valdez.subscriptions
    set status = 'canceled', updated_at = p_now
    where id = v_sub.id;
    -- A licença não cai aqui: o cliente pagou o mês corrente e usa até o
    -- expires_at. O vencimento é que devolve o servidor pro gratuito.
    return 'canceled';
  end if;

  insert into valdez.licenses (
    guild_id, plan, status, price_cents, founder,
    started_at, expires_at, external_ref, updated_at
  )
  values (
    v_sub.guild_id, v_sub.plan, 'active', v_sub.price_cents, v_sub.founder,
    p_now,
    case when v_sub.plan = 'lifetime' then null else p_expires_at end,
    p_correlation_id, p_now
  )
  on conflict (guild_id) do update set
    plan = excluded.plan,
    status = 'active',
    price_cents = excluded.price_cents,
    founder = excluded.founder,
    expires_at = excluded.expires_at,
    external_ref = excluded.external_ref,
    updated_at = excluded.updated_at;

  insert into valdez.payments (guild_id, amount_cents, method, external_ref, paid_at)
  values (v_sub.guild_id, v_sub.price_cents, 'woovi', p_correlation_id, p_now);

  update valdez.subscriptions
  set status = 'active', updated_at = p_now
  where id = v_sub.id;

  return 'paid';
end;
$$;

revoke all on function valdez.apply_woovi_event(text, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function valdez.apply_woovi_event(text, text, text, timestamptz, timestamptz)
  to service_role;

-- O painel passou a derivar "ativo" do vencimento, mas a coluna status continua
-- sendo o que o bot e a tela de assinatura leem. O bot expira o que venceu a
-- cada rodada de sync (expireRemoteLicenses); este UPDATE limpa o passivo que
-- já está lá com status='active' e expires_at vencido.
update valdez.licenses
set status = 'expired', updated_at = now()
where status = 'active'
  and expires_at is not null
  and expires_at < now();
