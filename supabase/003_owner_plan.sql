-- O meu próprio servidor entrava no painel como assinatura ativa de R$ 10: a
-- licença do dono era gravada como Máximo + fundador, e o preço de fundador
-- congela a mensalidade em R$ 10 pra qualquer plano mensal. Resultado: MRR,
-- ARR, ARPA e "assinaturas ativas" contavam dinheiro que ninguém pagou, e a
-- vaga de fundador que eu ocupava fazia a landing anunciar 99 restantes antes
-- do primeiro cliente existir.
-- `owner` é um plano de preço zero e fora do RECURRING_PLANS do painel, então
-- some das métricas de receita sem precisar excluir guild_id na mão.

alter table valdez.licenses drop constraint if exists licenses_plan_check;
alter table valdez.licenses add constraint licenses_plan_check
  check (plan in ('trial', 'basic', 'pro', 'max', 'lifetime', 'owner'));

-- Corrige a linha que já existe. O bot reaplica isso no boot (ensureOwnerLicense),
-- mas sem o UPDATE o painel seguiria mostrando R$ 10 até o próximo deploy.
update valdez.licenses
set plan = 'owner', price_cents = 0, founder = false, expires_at = null
where plan = 'max' and founder and price_cents = 1000;
