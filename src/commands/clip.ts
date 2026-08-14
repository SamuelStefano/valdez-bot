import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { getBufferSnapshot, isBuffering } from '../modules/replayBuffer';
import { publishClip, clipSecondsCap, formatLabel } from '../modules/clipPublisher';
import { hasOptedOut } from '../modules/guildSettings';
import { config } from '../config';

export const data = new SlashCommandBuilder()
  .setName('clip')
  .setDescription('Salva os últimos minutos da call como um clip')
  .setDMPermission(false)
  .addIntegerOption((opt) =>
    opt
      .setName('duracao')
      .setDescription('Quanto tempo voltar (padrão 2 min)')
      .addChoices(
        { name: '30 segundos', value: 30 },
        { name: '1 minuto', value: 60 },
        { name: '2 minutos', value: 120 },
        { name: '5 minutos', value: 300 },
        { name: '10 minutos', value: 600 },
        { name: '15 minutos', value: 900 }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Use este comando dentro de um servidor.', ephemeral: true });
    return;
  }

  if (!isBuffering(guildId)) {
    await interaction.reply({
      content:
        '⚠️ Não estou capturando áudio agora. Confira `/config status` — preciso estar na call com o indicador `[REC]`.',
      ephemeral: true,
    });
    return;
  }

  const requested = interaction.options.getInteger('duracao') ?? config.defaultClipSeconds;
  const cap = clipSecondsCap(interaction);
  const seconds = Math.min(requested, cap);

  await interaction.deferReply();

  const snapshot = getBufferSnapshot(guildId, seconds);
  if (snapshot.size === 0) {
    const extra = hasOptedOut(guildId, interaction.user.id)
      ? '\n*Você está em opt-out — sua voz não é capturada.*'
      : '';
    await interaction.editReply(`❌ Buffer vazio — ninguém falou nos últimos ${formatLabel(seconds)}.${extra}`);
    return;
  }

  if (seconds < requested) {
    await interaction.editReply(
      `⚠️ Este servidor aceita anexos menores, então cortei para os últimos ${formatLabel(seconds)}. Gerando...`
    );
  }

  await publishClip(interaction, { packets: snapshot, seconds, kind: 'clip' });
}
