import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { getBufferSnapshot, isBuffering } from '../modules/replayBuffer';
import { publishClip, clipSecondsCap, formatLabel, ClipFormat } from '../modules/clipPublisher';
import { hasOptedOut } from '../modules/guildSettings';
import { limits, upsell } from '../modules/licensing';
import { MAX_VIDEO_SECONDS } from '../utils/videoExporter';
import { track } from '../modules/telemetry';
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
  )
  .addStringOption((opt) =>
    opt
      .setName('formato')
      .setDescription('Áudio para ouvir, vídeo da sala para postar')
      .addChoices(
        { name: '🎧 Áudio (mp3)', value: 'mp3' },
        { name: '🎬 Vídeo da sala (mp4)', value: 'video' }
      )
  )
  .addUserOption((opt) =>
    opt.setName('pessoa').setDescription('Só a voz dessa pessoa, sem o resto da call')
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

  const plan = limits(guildId);
  const only = interaction.options.getUser('pessoa');
  if (only && !plan.isolatedClip) {
    await interaction.reply({ content: upsell('Clipe de uma voz só', 'max'), ephemeral: true });
    return;
  }

  const format = (interaction.options.getString('formato') ?? 'mp3') as ClipFormat;
  if (format === 'video' && !plan.roomVideo) {
    await interaction.reply({ content: upsell('Vídeo da sala', 'max'), ephemeral: true });
    return;
  }

  const requested = interaction.options.getInteger('duracao') ?? config.defaultClipSeconds;
  const planCap = plan.maxClipSeconds;
  // O render da sala cresce com a duração e a VPS é compartilhada com as calls ao
  // vivo. Cortar aqui é melhor que exportar 15 min e avisar depois que não deu.
  const videoCap = format === 'video' ? MAX_VIDEO_SECONDS : Infinity;
  const seconds = Math.min(requested, clipSecondsCap(interaction), planCap, videoCap);

  await interaction.deferReply();

  const full = getBufferSnapshot(guildId, seconds);
  // O buffer já guarda os pacotes separados por pessoa: filtrar o Map antes de
  // exportar entrega a faixa isolada sem tocar no mixer.
  const snapshot = only
    ? new Map([...full].filter(([userId]) => userId === only.id))
    : full;

  if (only && snapshot.size === 0) {
    await interaction.editReply(
      `❌ ${only.displayName} não falou nos últimos ${formatLabel(seconds)} — ou está em opt-out.`
    );
    return;
  }

  if (snapshot.size === 0) {
    const extra = hasOptedOut(guildId, interaction.user.id)
      ? '\n*Você está em opt-out — sua voz não é capturada.*'
      : '';
    await interaction.editReply(`❌ Buffer vazio — ninguém falou nos últimos ${formatLabel(seconds)}.${extra}`);
    return;
  }

  if (seconds < requested) {
    const motivo =
      videoCap <= seconds
        ? `o vídeo da sala vai até ${formatLabel(seconds)}`
        : planCap <= seconds
          ? `seu plano vai até ${formatLabel(planCap)} — veja \`/assinatura\``
          : 'este servidor aceita anexos menores';
    await interaction.editReply(`⚠️ Cortei para os últimos ${formatLabel(seconds)} (${motivo}). Gerando...`);
  }

  track(guildId, 'clip', { userId: interaction.user.id, seconds, detail: format });
  await publishClip(interaction, { packets: snapshot, seconds, kind: 'clip', format });
}
