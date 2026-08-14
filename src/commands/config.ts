import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { getSettings, saveSettings, optOutCount } from '../modules/guildSettings';
import { evaluatePresence, leaveChannel, isConnected } from '../modules/voiceManager';
import { limits, upsell, getLicense, daysLeft, SUPPORT_LABEL } from '../modules/licensing';
import { stopLiveCounter } from '../modules/liveCounter';
import { formatLabel } from '../modules/clipPublisher';
import {
  listRewards,
  setReward,
  removeReward,
  rewardIssue,
  MAX_REWARDS,
  MAX_LEVEL,
} from '../modules/roleRewards';

export const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Configura o Valdez neste servidor (só admin)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('canal')
      .setDescription('Define o canal de voz que o bot acompanha')
      .addChannelOption((opt) =>
        opt
          .setName('voz')
          .setDescription('Canal de voz')
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('clips')
      .setDescription('Define o canal de texto onde os clips são postados')
      .addChannelOption((opt) =>
        opt
          .setName('texto')
          .setDescription('Canal de texto')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('contador')
      .setDescription('Liga ou desliga o contador de horas ao vivo na call')
      .addBooleanOption((opt) =>
        opt.setName('ligado').setDescription('Deixar o contador na call').setRequired(true)
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName('cargos')
      .setDescription('Cargos entregues por nível de tempo em call')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Entrega um cargo quando alguém chega no nível')
          .addIntegerOption((opt) =>
            opt
              .setName('nivel')
              .setDescription('Nível que libera o cargo')
              .setMinValue(2)
              .setMaxValue(MAX_LEVEL)
              .setRequired(true)
          )
          .addRoleOption((opt) => opt.setName('cargo').setDescription('Cargo entregue').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('remover')
          .setDescription('Tira o cargo de um nível')
          .addIntegerOption((opt) =>
            opt.setName('nivel').setDescription('Nível a remover').setRequired(true)
          )
      )
      .addSubcommand((sub) => sub.setName('lista').setDescription('Lista os cargos por nível'))
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('Mostra a configuração atual'));

// Sem ChangeNickname o bot não consegue mostrar o [REC] e, por decisão de
// consentimento, não liga o buffer — o admin precisa ver isso, não descobrir
// pelo /clip vazio.
const REQUIRED_PERMISSIONS: [bigint, string][] = [
  [PermissionFlagsBits.ChangeNickname, 'Mudar Apelido'],
  [PermissionFlagsBits.Connect, 'Conectar'],
  [PermissionFlagsBits.Speak, 'Falar'],
  [PermissionFlagsBits.AttachFiles, 'Anexar Arquivos'],
];

function missingPermissions(interaction: ChatInputCommandInteraction): string[] {
  const me = interaction.guild?.members.me;
  if (!me) return [];
  return REQUIRED_PERMISSIONS.filter(([flag]) => !me.permissions.has(flag)).map(([, name]) => name);
}

function rewardsList(guildId: string): string {
  const rewards = listRewards(guildId);
  if (rewards.length === 0) return 'nenhum — `/config cargos add`';
  return rewards.map((r) => `Nível **${r.level}** → <@&${r.roleId}>`).join('\n');
}

// O cargo só é entregue de verdade se o bot puder mexer nele. Avisar na hora da
// configuração evita o admin descobrir pelo membro que nunca ganhou nada.
function hierarchyWarning(interaction: ChatInputCommandInteraction, rolePosition: number): string | null {
  const me = interaction.guild?.members.me;
  if (!me) return null;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return '⚠️ Falta a permissão **Gerenciar Cargos** — sem ela não entrego cargo nenhum.';
  }
  if (rolePosition >= me.roles.highest.position) {
    return '⚠️ Esse cargo está **acima do Valdez** na lista de cargos. Arraste o cargo do bot pra cima dele.';
  }
  return null;
}

async function handleCargos(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  sub: string
): Promise<void> {
  if (!limits(guildId).stats) {
    await interaction.reply({ content: upsell('Cargos por tempo de call'), ephemeral: true });
    return;
  }

  if (sub === 'lista') {
    const issue = rewardIssue(guildId);
    await interaction.reply({
      content: `🎖️ **Cargos por nível**\n${rewardsList(guildId)}${issue ? `\n\n⚠️ ${issue}` : ''}`,
      ephemeral: true,
    });
    return;
  }

  if (sub === 'remover') {
    const level = interaction.options.getInteger('nivel', true);
    const removed = removeReward(guildId, level);
    await interaction.reply({
      content: removed
        ? `🗑️ Nível ${level} não entrega mais cargo. Quem já ganhou continua com ele.`
        : `⚠️ Não tem cargo configurado no nível ${level}.`,
      ephemeral: true,
    });
    return;
  }

  const level = interaction.options.getInteger('nivel', true);
  const role = interaction.options.getRole('cargo', true);

  if (role.id === guildId) {
    await interaction.reply({ content: '❌ O `@everyone` todo mundo já tem.', ephemeral: true });
    return;
  }
  if ('managed' in role && role.managed) {
    await interaction.reply({
      content: '❌ Esse cargo é de bot/integração e o Discord não deixa ninguém entregar ele.',
      ephemeral: true,
    });
    return;
  }

  const existing = listRewards(guildId);
  if (existing.length >= MAX_REWARDS && !existing.some((r) => r.level === level)) {
    await interaction.reply({
      content: `❌ Limite de ${MAX_REWARDS} cargos por servidor. Remova um com \`/config cargos remover\`.`,
      ephemeral: true,
    });
    return;
  }

  setReward(guildId, level, role.id);
  const warning = hierarchyWarning(interaction, 'position' in role ? role.position : 0);

  await interaction.reply({
    content:
      `✅ Quem chegar no **nível ${level}** ganha **${role.name}**. ` +
      'Quem já passou disso pega o cargo assim que sair da próxima call.' +
      (warning ? `\n${warning}` : ''),
    ephemeral: true,
  });
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Use este comando dentro de um servidor.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (interaction.options.getSubcommandGroup(false) === 'cargos') {
    await handleCargos(interaction, guildId, sub);
    return;
  }

  if (sub === 'canal') {
    const channel = interaction.options.getChannel('voz', true);
    const previous = getSettings(guildId).voiceChannelId;
    saveSettings({ guildId, voiceChannelId: channel.id });

    // Trocar de canal com o bot dentro do antigo deixaria a conexão órfã.
    if (previous && previous !== channel.id && isConnected(guildId)) {
      await leaveChannel(interaction.client, guildId);
    }
    evaluatePresence(interaction.client, guildId);

    await interaction.reply({
      content: `✅ Canal de voz definido: <#${channel.id}>. Entro assim que tiver gente lá.`,
      ephemeral: true,
    });
    return;
  }

  if (sub === 'clips') {
    if (!limits(guildId).clipsChannel) {
      await interaction.reply({ content: upsell('Canal de clipes dedicado'), ephemeral: true });
      return;
    }
    const channel = interaction.options.getChannel('texto', true);
    saveSettings({ guildId, clipsChannelId: channel.id });
    await interaction.reply({ content: `✅ Clips vão para <#${channel.id}>.`, ephemeral: true });
    return;
  }

  if (sub === 'contador') {
    if (!limits(guildId).stats) {
      await interaction.reply({ content: upsell('Contador de horas ao vivo'), ephemeral: true });
      return;
    }
    const ligado = interaction.options.getBoolean('ligado', true);
    saveSettings({ guildId, liveCounter: ligado });
    if (!ligado) stopLiveCounter(interaction.client, guildId);

    await interaction.reply({
      content: ligado
        ? '✅ Contador ligado. Ele aparece na call e se atualiza sozinho a cada minuto.'
        : '⚪ Contador desligado. Use `/horas` quando quiser ver seu tempo.',
      ephemeral: true,
    });
    return;
  }

  const settings = getSettings(guildId);
  const plan = limits(guildId);
  const license = getLicense(guildId);
  const restam = daysLeft(license);
  const missing = missingPermissions(interaction);
  const issue = rewardIssue(guildId);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('⚙️ Configuração do Valdez')
    .addFields(
      {
        name: 'Canal de voz',
        value: settings.voiceChannelId ? `<#${settings.voiceChannelId}>` : '⚠️ não configurado — `/config canal`',
      },
      {
        name: 'Canal de clips',
        value: settings.clipsChannelId ? `<#${settings.clipsChannelId}>` : 'responde no próprio canal do comando',
      },
      { name: 'Presença automática', value: settings.autoJoin ? '🟢 ativa' : '⚪ desativada', inline: true },
      { name: 'Contador na call', value: settings.liveCounter ? '🟢 ligado' : '⚪ desligado', inline: true },
      { name: 'Na call agora', value: isConnected(guildId) ? 'sim' : 'não', inline: true },
      { name: 'Buffer', value: `últimos ${formatLabel(plan.bufferSeconds)}`, inline: true },
      { name: 'Opt-outs', value: `${optOutCount(guildId)} membro(s)`, inline: true },
      { name: 'Suporte', value: SUPPORT_LABEL[plan.support], inline: true },
      {
        name: 'Plano',
        value:
          license.status === 'active'
            ? `${plan.label}${restam !== null ? ` — ${restam} dia(s)` : ''}`
            : `⚠️ ${plan.label} vencido — \`/assinatura\``,
        inline: true,
      },
      {
        name: 'Permissões',
        value: missing.length === 0 ? '✅ tudo certo' : `⚠️ faltando: ${missing.join(', ')}`,
      },
      {
        name: 'Cargos por nível',
        value: plan.stats
          ? `${rewardsList(guildId)}${issue ? `\n⚠️ ${issue}` : ''}`
          : '🔒 disponível no Pro — `/assinatura`',
      }
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
