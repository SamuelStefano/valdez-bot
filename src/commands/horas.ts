import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { dbStatements } from '../utils/database';
import { formatDuration, getActiveSession } from '../modules/voiceTracker';
import { progressFor, progressBar } from '../modules/xp';

export const data = new SlashCommandBuilder()
  .setName('horas')
  .setDescription('Mostra suas horas em call')
  .addUserOption(opt =>
    opt.setName('usuario').setDescription('Ver horas de outro usuário').setRequired(false)
  )
  .addStringOption(opt =>
    opt
      .setName('periodo')
      .setDescription('Período de tempo')
      .setRequired(false)
      .addChoices(
        { name: 'Total', value: 'total' },
        { name: 'Este mês', value: 'month' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const targetUser = interaction.options.getUser('usuario') || interaction.user;
  const period = interaction.options.getString('periodo') || 'total';
  const guildId = interaction.guildId!;

  let totalSeconds: number;

  if (period === 'month') {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const startTimestamp = Math.floor(startOfMonth.getTime() / 1000);
    const result = dbStatements.getUserTimeMonth.get(targetUser.id, guildId, startTimestamp) as any;
    totalSeconds = result?.total_seconds || 0;
  } else {
    const result = dbStatements.getUserTime.get(targetUser.id, guildId) as any;
    totalSeconds = result?.total_seconds || 0;
  }

  // Add current session time if user is in call
  const activeJoinedAt = getActiveSession(guildId, targetUser.id);
  if (activeJoinedAt) {
    totalSeconds += Math.floor(Date.now() / 1000) - activeJoinedAt;
  }

  // O nível é sempre do acumulado: cair de nível na virada do mês seria punir
  // quem joga há mais tempo.
  const lifetime = (dbStatements.getUserTime.get(targetUser.id, guildId) as any)?.total_seconds || 0;
  const progress = progressFor(lifetime + (activeJoinedAt ? Math.floor(Date.now() / 1000) - activeJoinedAt : 0));

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎧 Horas em Call`)
    .setDescription(
      `**${targetUser.displayName}** ficou **${formatDuration(totalSeconds)}** em call${period === 'month' ? ' este mês' : ' no total'}.`
    )
    .addFields({
      name: `Nível ${progress.level}`,
      value: `\`${progressBar(progress)}\` ${progress.xp} XP\nFaltam **${progress.toNext} XP** pro nível ${progress.level + 1}.`,
    })
    .setThumbnail(targetUser.displayAvatarURL())
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
