import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { startRecording, stopRecording, getActiveRecordings, isBuffering } from '../modules/replayBuffer';
import { publishClip, formatLabel } from '../modules/clipPublisher';
import { limits, upsell } from '../modules/licensing';
import { track } from '../modules/telemetry';
import { config } from '../config';

export const data = new SlashCommandBuilder()
  .setName('replay')
  .setDescription('Grava a partir de agora (com os últimos 2 min já inclusos) até você mandar parar')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub.setName('start').setDescription('Começa a gravar (salva os últimos 2 min + continua)')
  )
  .addSubcommand((sub) =>
    sub.setName('stop').setDescription('Para a gravação e envia o áudio')
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Use este comando dentro de um servidor.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (!limits(guildId).replay) {
    await interaction.reply({ content: upsell('Gravação contínua'), ephemeral: true });
    return;
  }

  if (sub === 'start') {
    if (!isBuffering(guildId)) {
      await interaction.reply({
        content: '⚠️ Não estou capturando áudio agora. Entro na call quando tiver gente — veja `/config status`.',
        ephemeral: true,
      });
      return;
    }

    if (getActiveRecordings(guildId).size > 0) {
      await interaction.reply({
        content: '⚠️ Já tem uma gravação em andamento. Use `/replay stop` para parar.',
        ephemeral: true,
      });
      return;
    }

    startRecording(guildId, interaction.user.id);
    const lookback = formatLabel(config.startLookbackSeconds);
    const cap = Math.round(config.maxRecordingSeconds / 60);
    await interaction.reply(
      `🔴 **Gravando** — os últimos ${lookback} já entraram.\n` +
        `Use \`/replay stop\` para receber o áudio. Guardo no máximo os últimos ${cap} min.`
    );
    return;
  }

  if (sub === 'stop') {
    const active = getActiveRecordings(guildId);
    if (active.size === 0) {
      await interaction.reply({ content: '⚠️ Nenhuma gravação em andamento.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    const sessionId = active.keys().next().value!;
    const startedAt = active.get(sessionId)!.startedAt;
    const packets = stopRecording(guildId, sessionId);

    if (!packets || packets.size === 0) {
      await interaction.editReply('❌ Sem áudio capturado — ninguém falou nesse intervalo.');
      return;
    }

    // O buffer da gravação é podado em maxRecordingSeconds, então o relógio de
    // parede passa disso mas o áudio não — sem o teto o clip é anunciado com uma
    // duração que ele não tem.
    const elapsed = Math.min(
      Math.round((Date.now() - startedAt) / 1000),
      config.maxRecordingSeconds
    );
    const seconds = elapsed + config.startLookbackSeconds;

    track(guildId, 'replay', { userId: interaction.user.id, seconds, detail: 'mp3' });
    await publishClip(interaction, { packets, seconds, kind: 'replay' });
  }
}
