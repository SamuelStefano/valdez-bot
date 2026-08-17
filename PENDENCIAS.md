# Valdez — o que está aberto

Atualizado em 2026-08-17.

Ordem abaixo é a ordem de fazer. Passo 1 e 2 são de segundos e destravam o
que você viu quebrado agora.

---

## PASSO 1 — Autorizar o push do site (10 segundos)

**Problema que isso resolve:** você viu "3 dias" na landing.

O código já está sem teste grátis. O que está no ar não é o código: é um build
de `baa7470`, de antes da correção. Meu commit `6e4b0c2` está parado na sua
máquina porque push pra `main` = deploy, e deploy eu não faço sem seu ok.

**O que fazer:** me responder `pode pushar o site`.

Aí eu rodo:

```
cd /home/samuel/valdez-site && git push origin main
```

O workflow `.github/workflows/pages.yml` builda e publica sozinho, ~2 min.

**O que vai ao ar junto:** landing sem teste grátis, badge "Grátis pra sempre",
seção "VOCÊ PEDE, EU FAÇO", FAQ de pedido de função, termos de uso novos,
painel admin com funil "Rodando no grátis".

---

## PASSO 2 — Recarregar o Discord (5 segundos)

**Problema que isso resolve:** `This command is outdated, please try again in a few minutes`.

Não é bug do bot. Consultei a API: os 14 comandos estão registrados
globalmente, com IDs estáveis, `/help` incluso. O que aconteceu: o bot era
single-server e tinha comandos *guild-scoped*; virou multi-server e passou pra
*globais*. Seu cliente Discord ainda tem os IDs velhos em cache e tenta chamar
comando que não existe mais.

**O que fazer:** com o Discord aberto, `Ctrl+R` (ou `Cmd+R` no Mac). Se estiver
no navegador, `Ctrl+Shift+R`.

Não precisa reinstalar nada. Não vai acontecer de novo — a migração
guild→global é de uma vez só.

---

## PASSO 3 — Decidir o gateway de pagamento (D10)

**Por que é o próximo:** enquanto isso não fecha, você não recebe dinheiro. É o
único item que bloqueia o produto inteiro.

**O problema:** Pix Automático (cobrança recorrente sem o cliente aprovar toda
vez) não tem caminho pra CPF em provedor nenhum. Todos exigem CNPJ.

**Opção A — Abrir MEI + Woovi** *(minha recomendação)*
- MEI sai em ~1 dia no gov.br, custa ~R$ 76/mês de DAS.
- Woovi dá Pix Automático de verdade: cobra sozinho todo mês.
- Você emite nota, o que abre a porta de servidor de empresa/creator maior.
- Passos: abrir MEI no Portal do Empreendedor → abrir conta PJ → criar conta
  Woovi → me passar as chaves (via arquivo, não pelo chat).

**Opção B — Mercado Pago no CPF**
- Começa hoje, sem burocracia.
- **Não tem recorrência automática no Pix.** Todo mês o cliente precisa pagar
  um QR novo. Na prática você perde assinante por esquecimento.
- Serve como ponte até o MEI sair.

**O que fazer:** me responder `A`, `B`, ou `B agora e A depois`.

---

## PASSO 4 — Decidir o Supabase dedicado (D7)

**O risco:** hoje o Valdez roda no projeto Supabase *"Micro SaaS - Inovatech
Web Ia"*, que não é seu. Quem tem acesso àquele projeto lê suas licenças, seus
clientes e seu faturamento. Quando entrar cliente pagante, isso vira dado de
terceiro na mão de terceiro.

**A migração é pequena:** criar projeto novo no Supabase (grátis), rodar os 3
arquivos de `supabase/*.sql`, trocar 2 variáveis de ambiente. ~30 min meus,
zero downtime porque hoje só existe o seu servidor.

**O que fazer:** me responder `pode criar o Supabase do Valdez`. Você vai
precisar criar o projeto na sua conta (eu não crio projeto no seu nome) e me
passar a URL + a service key num arquivo — te mando o passo exato na hora.

**Recomendação:** fazer **antes** do primeiro cliente pagante. Depois vira
migração de dados de cliente.

---

## PASSO 5 — Destravar o login com Discord (A1 + A2 + A3)

**Problema que isso resolve:** `Unsupported provider: provider is not enabled`.

São 3 sub-passos, nesta ordem:

**5.1 — Habilitar o provider no Supabase**
Isso é meu, mas depende do 5.2. Fica pra depois.

**5.2 — Pegar as credenciais no Discord Developer Portal**
1. Abrir https://discord.com/developers/applications
2. Entrar no app `1365865955925819546` (o Valdez)
3. Menu lateral → **OAuth2**
4. Em **Redirects**, clicar `Add Redirect` e colar exatamente:
   `https://szqnmuebcatohtegxlxa.supabase.co/auth/v1/callback`
   *(se o PASSO 4 for aprovado, essa URL muda pro projeto novo — então faça o
   PASSO 4 primeiro, pra não cadastrar duas vezes)*
5. `Save Changes`
6. Ainda em OAuth2, em **Client Secret**, clicar `Reset Secret` e copiar

**5.3 — Me entregar o secret sem colar no chat**
No terminal:
```
echo 'COLE_O_SECRET_AQUI' > ~/.valdez-discord-secret && chmod 600 ~/.valdez-discord-secret
```
Depois me diz só `secret salvo`. Eu leio o arquivo sem imprimir o conteúdo.

**5.4 — Me dizer a URL de produção da landing**
Preciso pra allow-list de redirect do Supabase. Hoje o único endereço que
conheço é `samuelstefano.github.io/valdez-site`. Se for outro (ou se você
comprar domínio — ver PASSO 8), me fala qual.

---

## PASSO 6 — Decidir por onde o /feedback te manda email (D2)

O comando já está pronto e gateado em plano pago. Falta a entrega.

- **Resend** *(recomendo)* — 3.000 emails/mês grátis, API de 5 linhas. Você cria
  conta em resend.com, gera uma API key, salva num arquivo pra mim.
- **Gmail com app password** — funciona, mas Google derruba SMTP com frequência
  e o email cai em spam mais fácil.
- **n8n está fora.** É infra da DevFellowship. Este produto é seu, não pode
  depender de infra da empresa.

**O que fazer:** me responder `Resend` ou `Gmail`.

---

## PASSO 7 — Decidir os tiers e a copy (D1, D3, D4, D8, D9)

Nenhum bloqueia dinheiro. São ajustes de produto. Pode responder tudo de uma vez.

**D1 — Leaderboard e `/clear`: ficam no grátis ou sobem pro Básico?**
Você disse "pode deixar no plano mais barato". Hoje estão no grátis.
*Recomendo deixar no grátis:* o ranking é o que faz o pessoal voltar pro
servidor. Tirando, o grátis fica só com clip de 30s e não gera hábito — e sem
hábito ninguém assina.

**D3 — "Colocar o replay na call": o que você quis dizer?**
(a) o contador ao vivo mostrar que a gravação está ligada, ou
(b) listar o replay e o limite dele na tabela de planos do site.
*Já resolvi metade:* o `/help` agora informa o teto de 15 min por gravação.

**D4 — Categorias no menu `/`**
O Discord **não tem** agrupamento por categoria. Só existem dois caminhos:
(a) transformar tudo em subcomando (`/gravar clip`, `/musica play`) — agrupa de
verdade, mas quebra o dedo de quem já usa;
(b) `/help` com menu por categoria — *já implementei, está no ar*.
*Recomendo ficar no (b)* e reavaliar se o menu passar de ~20 comandos.

**D8 — Copy do vídeo da sala**
Manter "NOVIDADE" + comparação, ou afirmar "inédito" no duro?
*Recomendo manter.* Afirmação absoluta é fácil de alguém derrubar com um
concorrente qualquer, e aí você perde credibilidade no resto da página.

**D9 — Preço do vitalício**
Está R$ 150 no código; você falou "uns 120".
*Recomendo R$ 150* = 5 meses de Pro adiantados. A R$ 120 são 4 meses, e o
vitalício começa a canibalizar o mensal.

---

## PASSO 8 — Domínio (D11)

Hoje a landing vive num subdomínio do GitHub. Isso derruba conversão: ninguém
paga R$ 30/mês pra um `github.io`.

**O que fazer:** registrar um domínio (`valdezbot.com.br` sai ~R$ 40/ano no
registro.br; `.com` ~R$ 60/ano). Me falar qual, que eu configuro o DNS e o
GitHub Pages.

Se for fazer, **faça antes do PASSO 5**, pra cadastrar o redirect certo de
primeira.

---

## PASSO 9 — Manutenção da VPS (D5)

O disco está enchendo. O ofensor é o build cache do Docker, ~9 GB.

**O que fazer:** me responder `pode limpar`. Eu rodo o prune. Efeito colateral:
o próximo build de cada projeto da VPS fica mais lento uma vez.

**Sobre sua dúvida de onde ficam os dados:** o áudio **não** é o que enche o
disco. O buffer vive em memória e é descartado continuamente; o clipe vira
arquivo só quando alguém pede, sobe pro Discord e é apagado da máquina em
seguida. O que persiste é só o SQLite de licenças/horas (kilobytes) e o
espelho no Supabase. Disco cheio é Docker, não Valdez.

---

## PASSO 10 — Rotacionar credenciais do Craig (A4)

Não é do Valdez, é dívida de segurança aberta. Os arquivos
`~/CRAIG_FIX_STATUS.md` e `~/CRAIG_FULL_INVESTIGATION.md` têm token de bot e
`recordingWebhookSecret` em texto puro.

**O que fazer:** rotacionar os dois na infra DFL. Depois eu apago os arquivos.

Prioridade baixa comparado ao resto, mas credencial exposta não melhora com o
tempo.

---

## O que eu já implementei

- Teste grátis de 3 dias removido ponta a ponta (bot + site + termos de uso).
  Servidor novo cai direto no grátis, sem prazo e sem cartão.
- Grátis virou a **ausência** de licença: quem só instalou não vira linha no
  banco, não entra no MRR nem conta como churn quando sair.
- `/help` com menu por categoria, explicando cada comando e cada subcomando —
  inclusive o `/config cargos` que você não sabia pra que servia.
- `/help` informa o teto do replay: 15 min por gravação, para sozinha e posta
  o que gravou.
- `/feedback` gateado em plano pago.
- Landing: seção "VOCÊ PEDE, EU FAÇO", FAQ de pedido de função, card de garantia.
- Painel admin: funil virou "Rodando no grátis", conversão grátis → pago.

---

## Minha fila, destravada por você

| Item | Destravado por |
|------|----------------|
| Cobrança recorrente por Pix | PASSO 3 |
| Migração do Supabase | PASSO 4 |
| Login com Discord no site | PASSO 5 |
| Cadastro de usuário no site | PASSO 5 |
| Envio de email do `/feedback` | PASSO 6 |
| `pullLicenses` apagando `owner_id` no sync | nada — faço quando você liberar o push |

---

## Já estava certo, não mexi

- Grátis sem música.
- Vídeo da sala só no Máximo.
- Contador de call no Pro (intermediário).
- Música: Básico por link, Pro pra cima com playlist.
