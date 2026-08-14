# Lançamento do Valdez — domínio e marketing

Tudo aqui foi verificado na web em **14/08/2026**. Preço e disponibilidade mudam;
confira antes de pagar.

---

## 1. Domínio

### `valdez.com.br` está ocupado

Registrado, com DNS na hoteldaweb e validade até 25/11/2034. Não adianta esperar
vagar. Os livres, confirmados por WHOIS/RDAP oficial:

| Domínio | Situação | Preço/ano |
| --- | --- | --- |
| **`valdezbot.com.br`** | livre | **R$ 40** (Registro.br) |
| `usevaldez.com` | livre | ~US$ 10,44 (Cloudflare Registrar, at-cost) |
| `valdez.gg` | livre | ~US$ 51 (Spaceship) a US$ 100 (GoDaddy) |
| `valdez.bot` | livre, mas **descartado** | US$ 50–100 |

O `.bot` está fora: a Amazon Registry exige AWS account ID e um bot em framework
aprovado (Lex, Dialogflow, Microsoft Bot Framework, Pandorabots). discord.js não
entra nessa lista.

O `.gg` é o TLD com cara de Discord, mas custa 5 a 10 vezes mais e some do
orçamento de um produto que ainda não faturou.

### Recomendação: `valdezbot.com.br`

R$ 40/ano, tem "bot" no nome, e o `.com.br` passa confiança para o público que é
100% brasileiro. Exige **CPF** — o Registro.br só aceita pessoa física ou
jurídica estabelecida no Brasil, o que no seu caso não é obstáculo.

Se um dia o produto pagar as contas, `usevaldez.com` custa quase nada e vale como
segundo domínio para o público de fora.

### Passo a passo depois de comprar

1. **Registrar** em https://registro.br com CPF. Pague o boleto/Pix e espere o
   domínio sair de "aguardando pagamento".

2. **Apontar para o GitHub Pages.** No painel do Registro.br, use "Editar Zona
   DNS" e crie:

   ```
   @    A       185.199.108.153
   @    A       185.199.109.153
   @    A       185.199.110.153
   @    A       185.199.111.153
   www  CNAME   samuelstefano.github.io.
   ```

3. **Registrar o domínio no repositório.** Em
   `github.com/SamuelStefano/valdez-site` → Settings → Pages → Custom domain →
   `valdezbot.com.br` → Save. Marque **Enforce HTTPS** só depois que o
   certificado sair (leva de minutos a algumas horas).

   > O arquivo `CNAME` na raiz **não** resolve aqui: o deploy é por GitHub
   > Actions e cada build sobrescreve o conteúdo publicado. O campo em Settings é
   > o que persiste.

4. **Trocar a base do Vite.** Só depois que o HTTPS estiver ativo, em
   `.github/workflows/deploy.yml`, troque `VITE_BASE: /valdez-site/` por
   `VITE_BASE: /`. No domínio próprio o site fica na raiz, e manter o prefixo
   quebra todos os assets.

5. **Atualizar as URLs que apontam para o site**: `SITE_URL` no `.env` do bot
   (usado em `/assinatura` e no aviso de vencimento) e o `redirectTo` do login
   com Discord no Supabase.

6. **Liberar o redirect no Supabase.** Em Authentication → URL Configuration,
   adicione `https://valdezbot.com.br/**` ao `uri_allow_list`. **Não mexa no
   `site_url`** — esse projeto Supabase é compartilhado com outro app.

7. Se usar Cloudflare em algum momento, deixe o registro em **DNS only** (nuvem
   cinza) até o certificado do GitHub sair, senão o desafio HTTP falha.

---

## 2. Marketing

### O bloqueio que já foi resolvido: o nível gratuito

Antes, quando o teste de 3 dias acabava, o bot saía da call e não voltava. Isso
matava a descoberta orgânica: quem chega por um diretório clica em "Convidar",
testa em segundos e decide. Bot que some do servidor é bot que o dono remove — e
aí não sobra nada para vender depois.

**Já está no ar:** sem licença ativa o servidor cai no gratuito, com buffer de 30
segundos, sem prazo e sem cartão. O bot continua na call. 30s é curto o bastante
para o `/clip` frustrar na hora certa — a pérola boa quase sempre precisa do
contexto que veio antes dela — e é exatamente essa falta que vende o Básico.

O teste de 3 dias vende para quem já foi convencido; o gratuito é o que traz
gente para ser convencida. Com isso resolvido, o resto da lista faz sentido.

### Diretórios de bots (verificados no ar)

Publique em todos, é grátis e leva uma tarde:

| Site | URL | Observação |
| --- | --- | --- |
| Top.gg | https://top.gg | O maior. Tem tag `brasileiro` e lista bots com assinatura |
| Discord Bot List | https://discordbotlist.com | Tem categoria brasileira própria |
| Discord.Bots.GG | https://discord.bots.gg | Curadoria mais rígida, tráfego menor |
| Discadia | https://discadia.com | Servidores e bots |
| Botlist.me | https://botlist.me | Barreira baixa |

**Mortos, não perca tempo:** `disforge.com` redireciona para o discordservers.io
e não lista mais bots; `wumpus.store` não resolve DNS.

Regras específicas sobre bot pago em cada lista: **não consegui confirmar** (as
páginas de regras bloqueiam leitura automatizada). O que dá para afirmar é que as
diretrizes do Top.gg não proíbem paywall e há bots de assinatura listados lá. O
que elas exigem: bot online durante a revisão, público/convidável, comandos
principais funcionando e **sem exigir permissão de Administrador** — o Valdez já
cumpre os quatro.

Não existe diretório brasileiro dedicado a bots. O caminho BR é a tag `brasileiro`
no Top.gg, a categoria brasileira do Discord Bot List e servidores de divulgação
no DISBOARD.

### O canal assimétrico: vídeo curto

Diretório traz instalação passiva e converte pouco. O Valdez tem uma vantagem que
quase nenhum SaaS tem: **o produto gera o material de marketing sozinho.** Todo
clipe salvo é um vídeo pronto — áudio engraçado, contexto de call de amigos,
formato nativo de TikTok/Reels/Shorts.

Um clipe por dia, com a waveform na tela e a legenda "isso foi salvo 2 minutos
depois de acontecer", é o canal de menor custo e maior teto que existe aqui. Peça
autorização a quem aparece antes de postar.

Ordem prática:
1. ~~Nível gratuito no ar.~~ feito
2. Listar nos 5 diretórios.
3. Um clipe por dia por 30 dias, com link do site na bio.
4. Só então pensar em pagar tráfego.

### Atribuição, senão você fica no escuro

Nada disso serve se você não souber o que funcionou. Antes de começar:

- Guarde a origem da instalação em `guilds` (parâmetro na URL de convite: um
  convite diferente por diretório). **Essa coluna ainda não existe** — hoje o bot
  não sabe de onde veio nenhum servidor.
- Registre o código do indicador quando um servidor assina.
- Depois disso, o painel ganha uma aba de aquisição: sem a coluna, não há o que
  mostrar.

Com 5 servidores, dá para atribuir na mão. Com 50, não dá mais, e a informação já
foi perdida.

### O teto que chega antes do que parece

**Acima de 100 servidores o Discord exige verificação do bot**, com verificação de
identidade do dono via Stripe. Não é opcional: sem isso o bot para de entrar em
servidor novo.

Desde 10/06/2026 os *privileged intents* usam outro limiar — mais de 10.000
usuários únicos. O Valdez não depende deles, então o número que importa é o 100.

**Comece a verificação por volta de 75 servidores.** A análise demora e você não
quer descobrir isso com o crescimento travado.

Sobre gravar áudio: a Developer Policy trata voz como *End User Data* e exige que
o dado seja usado só para a função declarada, nunca "contra a expectativa do
usuário". Não achei cláusula que proíba gravação (a página bloqueia leitura
automatizada — **não confirmado**). O precedente é o Craig, que opera
publicamente há anos com aviso sonoro de gravação. O que protege o Valdez é o que
ele já faz: indicador `[REC]`, aviso no canal e opt-out por usuário. Não afrouxe
nenhum dos três.
