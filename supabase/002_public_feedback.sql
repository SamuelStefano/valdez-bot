-- Depoimento no site do Valdez.
--
-- Publicar exige DUAS permissões independentes: a pessoa marcou `publicar` no
-- /feedback (can_publish) e eu aprovei o texto no painel (published). Uma só não
-- basta — consentimento sem curadoria publica xingamento, curadoria sem
-- consentimento tira dado do Discord sem a pessoa saber.

alter table valdez.feedback add column if not exists can_publish boolean not null default false;
alter table valdez.feedback add column if not exists published boolean not null default false;

-- A view é o único objeto que o anônimo enxerga, e ela não tem guild_id nem
-- user_id: quem lê a landing não descobre em que servidor a pessoa está.
-- security_invoker off de propósito — a view roda como dona e o filtro do WHERE
-- é o que faz o papel da RLS aqui.
create or replace view valdez.public_feedback
with (security_invoker = off) as
select id, username, rating, message, created_at
from valdez.feedback
where can_publish and published
order by created_at desc;

revoke all on valdez.public_feedback from public;
grant usage on schema valdez to anon;
grant select on valdez.public_feedback to anon, authenticated;

-- O painel precisa marcar `published` e é a primeira escrita que sai do anon
-- key. O grant é por coluna: sem isso a policy deixaria um admin reescrever a
-- `message` alheia. O WITH CHECK segura o resto — não dá pra publicar o que a
-- pessoa não liberou.
drop policy if exists admin_publish on valdez.feedback;
create policy admin_publish on valdez.feedback
  for update to authenticated
  using (valdez.is_admin())
  with check (valdez.is_admin() and (not published or can_publish));

grant update (published) on valdez.feedback to authenticated;
