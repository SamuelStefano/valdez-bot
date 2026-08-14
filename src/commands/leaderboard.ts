import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { dbStatements } from '../utils/database';
import { formatDuration } from '../modules/voiceTracker';
import { progressFor } from '../modules/xp';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Ranking de horas em call')
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
  const period = interaction.options.getString('periodo') || 'total';
  const guildId = interaction.guildId!;

  let rows: any[];

  if (period === 'month') {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const startTimestamp = Math.floor(startOfMonth.getTime() / 1000);
    rows = dbStatements.getLeaderboardMonth.all(guildId, startTimestamp) as any[];
  } else {
    rows = dbStatements.getLeaderboard.all(guildId) as any[];
  }

  if (rows.length === 0) {
    await interaction.reply('Ninguém tem horas registradas ainda.');
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  // No ranking do mês a soma é parcial, então o nível dali não seria o nível
  // real do usuário — só mostra no acumulado.
  const lines = rows.map((row, i) => {
    const prefix = medals[i] || `**${i + 1}.**`;
    const level = period === 'month' ? '' : ` \`nv ${progressFor(row.total_seconds).level}\``;
    return `${prefix} **${row.username}** — ${formatDuration(row.total_seconds)}${level}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle(`🏆 Leaderboard${period === 'month' ? ' (Mês)' : ''}`)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
