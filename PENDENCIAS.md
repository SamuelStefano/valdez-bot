# Valdez — o que está aberto

Atualizado em 2026-08-17.

---

## 1. O que VOCÊ precisa fazer

Coisas que só você consegue destravar. Cada uma bloqueia algo meu.

| # | Ação | Onde | Bloqueia |
|---|------|------|----------|
| A1 | Adicionar o redirect `https://szqnmuebcatohtegxlxa.supabase.co/auth/v1/callback` | Discord Developer Portal → app `1365865955925819546` → OAuth2 → Redirects | Login com Discord no site |
| A2 | Colocar o **Client Secret** do OAuth em `~/.valdez-discord-secret` (não cole no chat) | Mesmo portal, aba OAuth2 | Login com Discord no site |
| A3 | Me dizer a **URL de produção da landing** | — | Allow-list do Supabase; hoje só existe `samuelstefano.github.io/valdez-site`, provavelmente morto |
| A4 | Rotacionar o token do bot Craig DFL e o `recordingWebhookSecret` | Infra DFL | Apagar `~/CRAIG_FIX_STATUS.md` e `~/CRAIG_FULL_INVESTIGATION.md` |

---

## 2. O que VOCÊ precisa decidir

Perguntei, ainda sem resposta. Não decido no seu lugar.

| # | Decisão | Contexto | Minha recomendação |
|---|---------|----------|--------------------|
| D1 | Leaderboard e `/clear` "no plano mais barato" = **Básico R$ 10**? | Hoje os dois estão no grátis. Movendo, o grátis fica só com clip de 30s, MP3 e XP. | Deixar no grátis. Ranking é o que faz o servidor voltar; tirar mata a adoção antes da venda. |
| D2 | Por onde o `/feedback` manda email pra você | Resend (grátis, 3k/mês), SMTP do Gmail com app password, ou outro. **n8n está fora**: é infra da DFL e este produto é seu. | Resend. |
| D3 | "Colocar o replay na call" — o que é? | (a) mostrar no contador ao vivo que a gravação está ligada, ou (b) listar replay + o limite na tabela de planos. | (a) + informar o teto, que já existe em `config.maxRecordingSeconds`. |
| D4 | Categorias no menu `/` | Discord **não tem** agrupamento por categoria. Só dá: (a) virar subcomandos (`/gravar clip`, `/musica play`) — agrupa de verdade mas quebra o hábito de quem já usa; (b) `/help` com menu por categoria. | (b) agora, (a) depois se o menu crescer. |
| D5 | Posso rodar `docker system prune` + limpar build cache? | Libera ~9 GB. Força rebuild dos outros projetos da VPS. | Sim, em janela sua. |
| D6 | Posso mexer na config de auth do Supabase **compartilhado**? | Só append no `uri_allow_list`, nunca sobrescrever, nunca tocar `site_url`. | Sim, mas ver D7. |
| D7 | Criar um **Supabase dedicado** pro Valdez? | Hoje ele roda no projeto "Micro SaaS - Inovatech Web Ia", que é de terceiro. Quem tem acesso lá lê suas licenças e sua receita. Migração = criar projeto, rodar os 3 SQL de `supabase/`, trocar 2 env vars. | Sim, **antes do primeiro cliente pagante**. |
| D8 | Copy da landing sobre o vídeo da sala | Manter "NOVIDADE" + comparação, ou afirmar "inédito" no duro. | Manter. Afirmação absoluta é fácil de derrubar. |
| D9 | Preço do vitalício | Hoje R$ 150 no código, você falou "uns 120". | R$ 150. 5 meses de Pro adiantados. |
| D10 | Gateway de pagamento | Pix Automático não tem caminho pra CPF em nenhum provedor. MEI + Woovi, ou Mercado Pago no CPF. | MEI + Woovi. |
| D11 | Domínio | `valdezbot.com` ou similar. | — |

---

## 3. O que eu já implementei

- Teste grátis de 3 dias removido ponta a ponta (bot + site + jurídico). Servidor novo cai direto no grátis.
- `/help` com menu por categoria, explicando cada comando e cada subcomando — inclusive `/config cargos`.
- `/feedback` gateado em plano pago.
- Landing: seção dizendo que o cliente pede alteração e função nova.
- Antes disso: `/clear`, vídeo da sala por botão, redesign do vídeo, seção "Vídeo da sala" na landing.

---

## 4. Fila minha, não bloqueada

- Cobrança recorrente por Pix (#11) — depende de D10.
- Cadastro de usuário no site (#22).
- Login com Discord (#24) — depende de A1, A2, A3.
- `pullLicenses` apagando `owner_id` no sync com o Supabase.
- Envio de email do `/feedback` — depende de D2.

---

## 5. Já estava certo, não mexi

- Grátis sem música.
- Vídeo da sala só no Máximo.
- Contador de call no Pro (intermediário).
- Música: Básico por link, Pro pra cima com playlist.
