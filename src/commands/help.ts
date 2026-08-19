import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from 'discord.js';
import { PLANS, limits, type Plan, type PlanLimits } from '../modules/licensing';
import { formatLabel } from '../modules/clipPublisher';
import { config } from '../config';

// O Discord não agrupa comandos por categoria no menu `/` — só existe grupo de
// subcomando. Então a categoria vive aqui, num menu que o usuário abre, em vez
// de virar uma renomeação de todos os comandos que já estão no dedo de quem usa.
type Category = 'gravacoes' | 'musica' | 'servidor' | 'conta';

const CATEGORY_LABEL: Record<Category, string> = {
  gravacoes: '🎙️ Gravações',
  musica: '🎵 Música',
  servidor: '📊 Servidor',
  conta: '💬 Conta e suporte',
};

const CATEGORY_HINT: Record<Category, string> = {
  gravacoes: 'Salvar a call, gravar do início ao fim e ficar fora da gravação',
  musica: 'Tocar e controlar o som na call',
  servidor: 'Horas, ranking, presença e configuração de admin',
  conta: 'Plano do servidor, pedidos e ajuda',
};

// Recurso booleano do plano. A doc aponta pra cá em vez de escrever "Pro" na
// mão: rebalancear plano não pode deixar o /help mentindo pro cliente.
type Gate = 'replay' | 'clipsChannel' | 'stats' | 'isolatedClip' | 'roomVideo' | 'weeklyRecap' | 'music';

const LADDER: Plan[] = ['free', 'basic', 'pro', 'max'];

function hasGate(plan: PlanLimits, gate: Gate): boolean {
  return gate === 'music' ? plan.music !== 'none' : plan[gate];
}

function cheapestWith(gate: Gate): string {
  const found = LADDER.find((p) => hasGate(PLANS[p], gate));
  return PLANS[found ?? 'max'].label;
}

function cheapestWithPlaylist(): string {
  const found = LADDER.find((p) => PLANS[p].music === 'playlist');
  return PLANS[found ?? 'max'].label;
}

interface Doc {
  name: string;
  usage: string;
  category: Category;
  summary: string;
  detail: string[];
  gate?: Gate;
}

const DOCS: Doc[] = [
  {
    name: '/clip',
    usage: '/clip [duração] [pessoa]',
    category: 'gravacoes',
    summary: 'Salva o que acabou de acontecer na call',
    detail: [
      'O bot segura os últimos minutos da call em memória o tempo todo. `/clip` corta essa janela e posta o MP3 no canal.',
      '**duração** — quantos segundos voltar. Sem informar, volta 2 minutos. O teto é o do seu plano.',
      `**pessoa** — isola a voz de um membro só, sem o resto da call por cima. Só no ${cheapestWith('isolatedClip')}.`,
      `Embaixo do clip aparecem dois botões: **MP3** e **Vídeo da sala**. O vídeo mostra o avatar de cada um acendendo em verde na hora exata em que a pessoa falou — é do ${cheapestWith('roomVideo')}.`,
      'Quem deu `/privacidade optout` não entra no clip.',
    ],
  },
  {
    name: '/replay',
    usage: '/replay start · stop',
    category: 'gravacoes',
    summary: 'Grava a call inteira, do início ao fim',
    detail: [
      '`/clip` depende da janela do buffer. O `/replay` liga a gravação contínua pra quando você já sabe que a call vai render.',
      '**start** — começa a gravar. O bot avisa no canal e mostra o tempo máximo da gravação.',
      '**stop** — para e posta o áudio, com os mesmos botões de MP3 e vídeo do `/clip`.',
      `A gravação **não é ilimitada**: o teto é de ${formatLabel(config.maxRecordingSeconds)} por gravação. Ao bater o teto ela para sozinha e posta o que gravou — nada é perdido, e dá pra dar start de novo na sequência.`,
    ],
    gate: 'replay',
  },
  {
    name: '/privacidade',
    usage: '/privacidade optout · optin · status',
    category: 'gravacoes',
    summary: 'Tira a sua voz da gravação',
    detail: [
      '**optout** — sua voz nunca mais entra no buffer, e o que já estava guardado de você é descartado na hora. Não precisa pedir pra admin nenhum.',
      '**optin** — volta a participar das gravações.',
      '**status** — diz em qual dos dois você está agora.',
      'Vale por servidor. Sair da gravação não te tira da call nem do ranking de horas.',
    ],
  },
  {
    name: '/play',
    usage: '/play <link ou nome>',
    category: 'musica',
    summary: 'Toca música na call',
    detail: [
      'Aceita link do YouTube, link do Spotify ou só o nome da faixa.',
      `Faixa avulsa começa no ${cheapestWith('music')}. Playlist e álbum inteiros entram no ${cheapestWithPlaylist()}.`,
      'Se já tiver algo tocando, entra na fila. O bot precisa estar na call.',
    ],
    gate: 'music',
  },
  {
    name: '/music',
    usage: '/music skip · previous · pause · resume · stop · loop · queue · np',
    category: 'musica',
    summary: 'Controla o que está tocando',
    detail: [
      '**skip** pula, **previous** volta pra anterior, **pause** e **resume** param e retomam, **stop** encerra e limpa a fila.',
      '**loop** repete, **queue** mostra a fila inteira e **np** mostra só o que está tocando agora.',
      'Os mesmos controles ficam em botões embaixo da mensagem da música, pra ninguém precisar digitar no meio da call.',
    ],
    gate: 'music',
  },
  {
    name: '/horas',
    usage: '/horas [usuário] [período]',
    category: 'servidor',
    summary: 'Quanto tempo você viveu na call',
    detail: [
      'Mostra suas horas em call, seu nível e quanto falta pro próximo.',
      '**usuário** — mostra as horas de outra pessoa. **período** — recorta em semana, mês ou total.',
      'O tempo é contado enquanto você está no canal de voz que o admin configurou em `/config canal`.',
    ],
  },
  {
    name: '/leaderboard',
    usage: '/leaderboard [período]',
    category: 'servidor',
    summary: 'O ranking de horas do servidor',
    detail: [
      'Quem mais ficou em call, em semana, mês ou total. O ranking da semana zera toda segunda-feira.',
      'É o que cria a disputa que não deixa o servidor esfriar — por isso ele existe até no grátis.',
    ],
  },
  {
    name: '/call',
    usage: '/call entrar · sair · status',
    category: 'servidor',
    summary: 'Liga e desliga a presença automática',
    detail: [
      'Por padrão o Valdez entra sozinho quando aparece gente na call.',
      '**entrar** traz ele agora, **sair** manda embora, **status** diz onde ele está.',
      'Desligar a presença automática também desliga o buffer — sem o bot na call não existe `/clip`.',
    ],
  },
  {
    name: '/clear',
    usage: '/clear <quantidade>',
    category: 'servidor',
    summary: 'Limpa o canal de texto',
    detail: [
      'Apaga de uma vez as últimas mensagens do canal, até 100 por comando.',
      'Só aparece pra quem tem permissão de **Gerenciar Mensagens**.',
      'O Discord não deixa apagar em lote mensagem com mais de 14 dias — quando isso acontece, eu digo quantas ficaram.',
    ],
  },
  {
    name: '/config',
    usage: '/config canal · clips · contador · avisos · momentos · cargos · status',
    category: 'servidor',
    summary: 'A configuração do servidor (só admin)',
    detail: [
      '**canal** — define o canal de voz que o bot acompanha. Sem isso ele não entra em lugar nenhum.',
      '**clips** — canal de texto onde os clips caem. Sem definir, o clip responde no próprio canal do comando.',
      '**contador** — liga o contador de horas ao vivo no nome da call, atualizado a cada minuto.',
      '**avisos** — posta no canal de texto quem abriu a call, quem entrou e quanto tempo cada um ficou.',
      '**momentos** — o Valdez corta e posta sozinho os últimos 25s quando a call inteira reage junto (risada, grito). No máximo 3 por call.',
      '**cargos add `<nível>` `<cargo>`** — entrega um cargo automaticamente quando alguém chega naquele nível de horas em call. Quem já passou do nível ganha o cargo ao sair da próxima call. É o "cargo de veterano" sem ninguém precisar distribuir na mão.',
      '**cargos remover `<nível>`** — para de entregar naquele nível. Quem já ganhou continua com o cargo.',
      '**cargos lista** — mostra o que está configurado e avisa se o cargo do Valdez está abaixo do cargo que ele deveria entregar (nesse caso o Discord bloqueia a entrega).',
      '**status** — mostra tudo: canais, plano, buffer, opt-outs e as permissões que estão faltando.',
    ],
  },
  {
    name: '/assinatura',
    usage: '/assinatura',
    category: 'conta',
    summary: 'O plano deste servidor',
    detail: [
      'Mostra o que está ativo hoje, quanto tempo falta e o que cada plano libera.',
      'Se você já paga, ele calcula quanto custa subir de plano agora: o que sobrou do mês vira crédito e o vencimento não muda.',
    ],
  },
  {
    name: '/feedback',
    usage: '/feedback <mensagem> [nota] [publicar]',
    category: 'conta',
    summary: 'Pede uma mudança ou reporta um bug',
    detail: [
      'Cai direto comigo. Eu leio tudo.',
      'Serve pra bug, pra o que faltou e principalmente pra **pedir função nova** — o que servidor pagante pede entra na fila de verdade.',
      '**nota** — de 1 a 5, o quanto o bot te atende hoje.',
      '**publicar** — me autoriza a usar seu recado no site, com seu nome do Discord. Sem marcar, fica só comigo.',
      `Limite de 3 por dia por pessoa. Precisa de plano pago — do ${PLANS.basic.label} pra cima.`,
    ],
  },
  {
    name: '/help',
    usage: '/help [comando]',
    category: 'conta',
    summary: 'Esta lista',
    detail: ['Sem argumento, abre o menu por categoria.', 'Com um comando, explica só ele.'],
  },
];

const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[];

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Explica todos os comandos do Valdez')
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName('comando')
      .setDescription('Explica um comando específico')
      .addChoices(...DOCS.map((d) => ({ name: d.name, value: d.name })))
  );

function gateLine(doc: Doc, plan: PlanLimits): string {
  if (!doc.gate) return '';
  const from = cheapestWith(doc.gate);
  return hasGate(plan, doc.gate)
    ? `\n✅ Liberado no seu plano.`
    : `\n🔒 A partir do **${from}** — veja em \`/assinatura\`.`;
}

function docEmbed(doc: Doc, plan: PlanLimits): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(doc.usage)
    .setDescription(doc.detail.map((l) => `• ${l}`).join('\n') + gateLine(doc, plan))
    .setFooter({ text: CATEGORY_LABEL[doc.category] });
}

function categoryEmbed(category: Category, plan: PlanLimits): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(CATEGORY_LABEL[category])
    .setDescription(CATEGORY_HINT[category]);

  for (const doc of DOCS.filter((d) => d.category === category)) {
    embed.addFields({
      name: doc.usage,
      value: doc.detail.map((l) => `• ${l}`).join('\n') + gateLine(doc, plan),
    });
  }
  return embed;
}

function overviewEmbed(plan: PlanLimits): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Comandos do Valdez')
    .setDescription(
      `Este servidor está no **${plan.label}**, com buffer dos últimos **${formatLabel(plan.bufferSeconds)}**.\n` +
        'Escolha uma categoria abaixo pra ver a explicação detalhada de cada comando.'
    );

  for (const category of CATEGORIES) {
    embed.addFields({
      name: CATEGORY_LABEL[category],
      value: DOCS.filter((d) => d.category === category)
        .map((d) => `\`${d.name}\` — ${d.summary}`)
        .join('\n'),
    });
  }

  if (config.siteUrl) embed.setURL(config.siteUrl);
  return embed;
}

function menu(selected?: Category): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('help:cat')
      .setPlaceholder('Ver uma categoria em detalhe')
      .addOptions(
        CATEGORIES.map((c) => ({
          label: CATEGORY_LABEL[c],
          description: CATEGORY_HINT[c].slice(0, 100),
          value: c,
          default: c === selected,
        }))
      )
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Use este comando dentro de um servidor.', ephemeral: true });
    return;
  }

  const plan = limits(guildId);
  const wanted = interaction.options.getString('comando');
  const doc = wanted ? DOCS.find((d) => d.name === wanted) : null;

  await interaction.reply({
    embeds: [doc ? docEmbed(doc, plan) : overviewEmbed(plan)],
    components: [menu(doc?.category)],
    ephemeral: true,
  });
}

export async function handleHelpSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const category = interaction.values[0] as Category;
  if (!CATEGORIES.includes(category) || !interaction.guildId) return;

  await interaction.update({
    embeds: [categoryEmbed(category, limits(interaction.guildId))],
    components: [menu(category)],
  });
}
