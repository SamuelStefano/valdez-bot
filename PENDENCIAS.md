# Valdez — o que está aberto

Atualizado em 2026-08-17, depois das suas 10 respostas.

---

## DECIDIDO (você delegou, eu decidi)

### Gateway: **Woovi**

Você tem MEI, então CNPJ não é problema e as duas opções estavam abertas.
Pesquisei taxa atual das três candidatas contra os *seus* preços:

| Provedor | Taxa | No plano R$ 10 | No plano R$ 30 |
|---|---|---|---|
| **Woovi** | 0,80%, mínimo R$ 0,50 | R$ 0,50 (5%) | R$ 0,50 (1,7%) |
| Asaas | 30 grátis/mês, depois **R$ 2,00 fixo** | R$ 2,00 (**20%**) | R$ 2,00 (6,7%) |
| Mercado Pago | recorrência só cartão/saldo | — | — |

**Mercado Pago está fora:** a recorrência dele (`/preapproval`) roda com cartão de
crédito e saldo em conta. Não achei confirmação de Pix Automático via API. Seu
público é jovem brasileiro — exigir cartão de crédito corta metade dele.

**Asaas parece grátis e vira armadilha.** Os 30 Pix/mês grátis cobrem o começo,
mas o R$ 2,00 fixo depois disso come **20% do plano de R$ 10** — que é
justamente o preço de fundador dos seus 100 primeiros servidores.

**Woovi ganha por não precisar de migração.** Trocar de gateway depois obriga
*cada assinante* a reautorizar o débito recorrente, e reautorização é evento de
churn: parte não refaz e você perde receita que já tinha. Como o custo absoluto
da Woovi hoje é irrisório (10 assinantes = R$ 5/mês), não existe motivo pra
economizar agora e pagar migração depois.

Pix Automático está em produção desde 16/06/2025 (Resolução BCB 402) e a Woovi
expõe por API (`POST /api/v1/subscriptions`).

> ⚠️ Efeito colateral que vale saber: R$ 0,50 sobre R$ 10 é 5% de taxa. O plano
> de fundador tem margem fina. Não muda a decisão, mas pesa se um dia você
> pensar em baixar mais o preço de entrada.

### Email do /feedback: **Resend**

Free tier confirmado: 3.000 emails/mês, 100/dia. O detalhe que decide: **sem
domínio próprio verificado**, a Resend envia de `onboarding@resend.dev` e só
para o email dono da conta. Que é exatamente o seu caso — o `/feedback` manda
pra você e mais ninguém. Ou seja, funciona hoje, sem esperar o domínio.

(AWS SES exige aprovação pra sair do sandbox; Gmail com app password cai em
spam e o Google derruba. Não valem o trabalho pra ~20 emails/mês.)

### Hospedagem: **Vercel**

Dokploy roda na sua VPS — a mesma que caiu por memória em julho e vive com
disco cheio. Página de vendas na máquina que já caiu significa que, quando ela
cair de novo, ninguém consegue assinar. Vercel é grátis, CDN global, domínio
custom sem custo, e o `vercel.json` já está no repo.

**Atenção:** hospedagem ≠ domínio. Você ainda precisa registrar um.

---

## O QUE FALTA VOCÊ FAZER

Tudo abaixo é "criar conta e me passar a chave". Nenhuma eu consigo criar no
seu nome. Depois de cada uma, eu implemento sozinho.

### 1. Registrar o domínio
`valdezbot.com.br` sai ~R$ 40/ano no registro.br; `.com` ~R$ 60/ano no
Namecheap/Cloudflare. **Faça primeiro** — o endereço entra na config da Vercel
*e* no redirect do Discord, e cadastrar errado obriga a refazer os dois.

Me diz o nome que você registrou.

### 2. Criar projeto Supabase do Valdez
1. Entrar em https://supabase.com/dashboard com a **sua** conta
2. `New project` → nome `valdez` → região `South America (São Paulo)`
3. Guardar a senha do banco que ele gera
4. Ir em `Project Settings` → `API` e copiar **Project URL** e **service_role key**
5. Salvar pra mim sem colar no chat:
```
cat > ~/.valdez-supabase <<'EOF'
URL=https://xxxx.supabase.co
SERVICE_ROLE=eyJ...
EOF
chmod 600 ~/.valdez-supabase
```
Me diz `supabase pronto`. Eu rodo os 3 SQL, migro e troco as env vars.

**Por que importa:** hoje suas licenças e sua receita moram no projeto
*"Micro SaaS - Inovatech Web Ia"*, que não é seu. Quem tem acesso lá lê tudo.

### 3. Criar conta Woovi
1. https://woovi.com → criar conta com o CNPJ do MEI
2. Menu **API / Integrações** → gerar **AppID**
3. Salvar:
```
echo 'APPID_AQUI' > ~/.valdez-woovi && chmod 600 ~/.valdez-woovi
```
Me diz `woovi pronto`. Eu implemento cobrança recorrente + webhook.

### 4. Criar conta Resend
1. https://resend.com → criar conta **com o email que você quer receber o feedback**
2. `API Keys` → `Create API Key` → permissão `Sending access`
3. Salvar:
```
echo 're_...' > ~/.valdez-resend && chmod 600 ~/.valdez-resend
```
Me diz `resend pronto`. Eu ligo o `/feedback` no email.

### 5. Discord OAuth (só depois do 1 e do 2)
1. https://discord.com/developers/applications → app `1365865955925819546`
2. **OAuth2** → `Add Redirect` → colar a callback do Supabase **novo**
   (te passo a URL exata quando o passo 2 estiver pronto)
3. `Save Changes`
4. **Client Secret** → `Reset Secret` → copiar
5. `echo 'SECRET' > ~/.valdez-discord-secret && chmod 600 ~/.valdez-discord-secret`

Isso destrava o `Unsupported provider` e o login no site.

### 6. Rotacionar credenciais do Craig
Token de bot e `recordingWebhookSecret` estão em texto puro em
`~/CRAIG_FIX_STATUS.md` e `~/CRAIG_FULL_INVESTIGATION.md`. Não é do Valdez, mas
credencial exposta não melhora com o tempo. Rotaciona na infra DFL que eu apago
os arquivos.

---

## JÁ ESTÁ NO AR

- Landing sem teste grátis, publicada. Meta description corrigida também.
- Vídeo da sala afirmado como **inédito**: *"Nenhum outro bot de Discord
  devolve isso."*
- Contador ao vivo mostra `🔴 Gravando — 04:12 de 15:00` durante o `/replay`.
  Quem entra no meio da call vê que está gravando, sem depender do `[REC]`.
- `owner_id` não é mais apagado a cada sync com o Supabase.
- `/help` com menu por categoria, incluindo o `/config cargos`.
- `/feedback` gateado em plano pago.
- Grátis virou a ausência de licença: quem só instalou não polui MRR nem churn.
- Leaderboard e `/clear` **ficam no grátis** (sua resposta 5).
- Categorias **ficam no `/help`** (sua resposta 7).
- Vitalício **R$ 150** (sua resposta 9).
- `docker prune` cancelado — você já liberou espaço.

---

## MINHA FILA

| Item | Destravado por |
|---|---|
| Migração do Supabase | você fazer o passo 2 |
| Cobrança recorrente Woovi + webhook | passo 3 |
| Email do `/feedback` | passo 4 |
| Migração pra Vercel | passo 1 |
| Login com Discord | passos 1, 2 e 5 |
| Cadastro de usuário no site | login com Discord |
