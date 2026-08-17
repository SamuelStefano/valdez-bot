-- O teste de 3 dias saiu do produto: o cliente paga e recebe, sem período
-- gratuito por tempo. Quem estava em teste vira `expired` e cai no gratuito, que
-- não é linha de licença nenhuma — é a ausência dela.
update valdez.licenses set status = 'expired' where plan = 'trial';

delete from valdez.licenses where plan = 'trial';

alter table valdez.licenses drop constraint if exists licenses_plan_check;
alter table valdez.licenses add constraint licenses_plan_check
  check (plan in ('basic', 'pro', 'max', 'lifetime', 'owner'));

alter table valdez.licenses alter column plan set default 'basic';
