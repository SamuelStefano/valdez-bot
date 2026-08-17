import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { track } from '../modules/telemetry';

// O bulkDelete do Discord só aceita 100 por chamada e recusa mensagem com mais
// de 14 dias — os dois limites são da API, não escolha nossa.
const MAX_MESSAGES = 100;

export const data = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Apaga as últimas mensagens deste canal')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .setDMPermission(false)
  .addIntegerOption((opt) =>
    opt
      .setName('quantidade')
      .setDescription(`Quantas mensagens apagar (1 a ${MAX_MESSAGES})`)
      .setMinValue(1)
      .setMaxValue(MAX_MESSAGES)
      .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Use este comando dentro de um servidor.', ephemeral: true });
    return;
  }

  // setDefaultMemberPermissions é só o padrão: o admin do servidor pode liberar o
  // comando pra qualquer cargo no painel de integrações. A checagem real é aqui.
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.permissionsIn(interaction.channelId).has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content: '❌ Você precisa da permissão **Gerenciar mensagens** neste canal.',
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await interaction.reply({ content: '❌ Só consigo limpar canais de texto.', ephemeral: true });
    return;
  }

  const me = interaction.guild?.members.me;
  if (!me?.permissionsIn(channel.id).has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content: '❌ Não tenho permissão de **Gerenciar mensagens** aqui. Peça pro admin liberar.',
      ephemeral: true,
    });
    return;
  }

  const requested = interaction.options.getInteger('quantidade', true);

  // Efêmero de propósito: quem está no canal vê as mensagens sumirem, não precisa
  // ver também um aviso do bot ocupando o lugar delas.
  await interaction.deferReply({ ephemeral: true });

  try {
    const deleted = await (channel as TextChannel).bulkDelete(requested, true);
    track(guildId, 'clear', { userId: interaction.user.id, detail: String(deleted.size) });

    if (deleted.size === 0) {
      await interaction.editReply(
        '⚠️ Nada apagado — o Discord não deixa apagar mensagens com mais de 14 dias.'
      );
      return;
    }

    const sobra =
      deleted.size < requested
        ? '\n*As demais têm mais de 14 dias e o Discord não deixa apagar em lote.*'
        : '';
    await interaction.editReply(
      `🧹 Apaguei **${deleted.size}** ${deleted.size === 1 ? 'mensagem' : 'mensagens'}.${sobra}`
    );
  } catch (err: any) {
    await interaction.editReply(`❌ Não consegui apagar: ${err?.message ?? 'erro desconhecido'}`);
  }
}
