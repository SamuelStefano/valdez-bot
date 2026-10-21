import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Message,
  TextChannel,
} from 'discord.js';
import { track } from '../modules/telemetry';
import { splitByAge } from './clearPlan';

// Discord's bulkDelete takes 100 per call and refuses anything past 14 days, so
// older messages are deleted one by one. That path is rate-limited to roughly
// one per second, which is what caps the total.
const MAX_MESSAGES = 500;
const PAGE_SIZE = 100;
const PROGRESS_EVERY = 25;

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

  const textChannel = channel as TextChannel;
  let deletedCount = 0;
  let failedCount = 0;

  try {
    const targets: Message[] = [];
    let before: string | undefined;
    while (targets.length < requested) {
      const page = await textChannel.messages.fetch({
        limit: Math.min(PAGE_SIZE, requested - targets.length),
        before,
      });
      if (page.size === 0) break;
      targets.push(...page.values());
      before = page.last()?.id;
    }

    const { recent, old } = splitByAge(targets, Date.now());

    for (let i = 0; i < recent.length; i += PAGE_SIZE) {
      const batch = recent.slice(i, i + PAGE_SIZE);
      if (batch.length === 1) {
        await batch[0].delete();
        deletedCount += 1;
      } else {
        const deleted = await textChannel.bulkDelete(batch, true);
        deletedCount += deleted.size;
      }
    }

    if (old.length > 0) {
      await interaction.editReply(
        `🧹 Apaguei **${deletedCount}**. Agora vou uma a uma nas **${old.length}** com mais de 14 dias — demora uns ${Math.ceil(old.length / 60)} min.`
      );
    }

    for (const [index, message] of old.entries()) {
      try {
        await message.delete();
        deletedCount += 1;
      } catch {
        failedCount += 1;
      }
      if ((index + 1) % PROGRESS_EVERY === 0 && index + 1 < old.length) {
        await interaction
          .editReply(`🧹 Apagando as antigas… **${index + 1}/${old.length}**`)
          .catch(() => {});
      }
    }

    track(guildId, 'clear', { userId: interaction.user.id, detail: String(deletedCount) });

    if (deletedCount === 0) {
      await interaction.editReply('⚠️ Nada apagado — o canal não tem mensagens.');
      return;
    }

    const sobra = targets.length < requested ? '\n*O canal não tinha mais que isso.*' : '';
    const falhas = failedCount > 0 ? `\n*${failedCount} não puderam ser apagadas.*` : '';
    await interaction.editReply(
      `🧹 Apaguei **${deletedCount}** ${deletedCount === 1 ? 'mensagem' : 'mensagens'}.${sobra}${falhas}`
    );
  } catch (err: any) {
    await interaction
      .editReply(
        `❌ Parei depois de apagar ${deletedCount}: ${err?.message ?? 'erro desconhecido'}`
      )
      .catch(() => {});
  }
}
