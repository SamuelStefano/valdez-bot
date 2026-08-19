import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { getBufferSnapshot, isBuffering } from '../modules/replayBuffer';
import { publishClip, clipSecondsCap, formatLabel } from '../modules/clipPublisher';
import { hasOptedOut } from '../modules/guildSettings';
import { limits, upsell } from '../modules/licensing';
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

  const requested = interaction.options.getInteger('duracao') ?? config.defaultClipSeconds;
  const planCap = plan.maxClipSeconds;
  const seconds = Math.min(requested, clipSecondsCap(interaction), planCap);

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

  const motivo =
    planCap <= seconds
      ? `seu plano vai até ${formatLabel(planCap)} — veja \`/assinatura\``
      : 'este servidor aceita anexos menores';
  const notice =
    seconds < requested ? `⚠️ Cortei para os últimos ${formatLabel(seconds)} (${motivo}).` : undefined;

  track(guildId, 'clip', { userId: interaction.user.id, seconds, detail: 'mp3' });
  await publishClip(interaction, { packets: snapshot, seconds, kind: 'clip', notice });
}
