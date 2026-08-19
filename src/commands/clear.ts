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

  // O fetch do membro é REST e pode passar dos 3s que o Discord dá pra responder;
  // sem o defer antes, o comando morria calado.
  await interaction.deferReply({ ephemeral: true });

  // setDefaultMemberPermissions é só o padrão: o admin do servidor pode liberar o
  // comando pra qualquer cargo no painel de integrações. A checagem real é aqui.
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.permissionsIn(interaction.channelId).has(PermissionFlagsBits.ManageMessages)) {
    await interaction.editReply('❌ Você precisa da permissão **Gerenciar mensagens** neste canal.');
    return;
  }

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await interaction.editReply('❌ Só consigo limpar canais de texto.');
    return;
  }

  const me = interaction.guild?.members.me;
  if (!me?.permissionsIn(channel.id).has(PermissionFlagsBits.ManageMessages)) {
    await interaction.editReply(
      '❌ Não tenho permissão de **Gerenciar mensagens** aqui. Peça pro admin liberar.'
    );
    return;
  }

  const requested = interaction.options.getInteger('quantidade', true);

  try {
    const deleted = await (channel as TextChannel).bulkDelete(requested, true);
    track(guildId, 'clear', { userId: interaction.user.id, detail: String(deleted.size) });

    if (deleted.size === 0) {
      await interaction.editReply(
        '⚠️ Nada apagado — o Discord não deixa apagar mensagens com mais de 14 dias.'
      );
      return;
    }

    // Faltar mensagem quase sempre é canal com menos histórico que o pedido; a
    // regra dos 14 dias é a exceção, e culpá-la sempre era informação falsa.
    const sobra =
      deleted.size < requested
        ? '\n*O canal não tinha mais que isso, ou as demais passam de 14 dias.*'
        : '';
    await interaction.editReply(
      `🧹 Apaguei **${deleted.size}** ${deleted.size === 1 ? 'mensagem' : 'mensagens'}.${sobra}`
    );
  } catch (err: any) {
    await interaction.editReply(`❌ Não consegui apagar: ${err?.message ?? 'erro desconhecido'}`);
  }
}
