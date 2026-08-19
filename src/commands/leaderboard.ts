import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { dbStatements } from '../utils/database';
import { formatDuration, listActiveSessions } from '../modules/voiceTracker';
import { progressFor } from '../modules/xp';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Ranking de horas em call')
  .setDMPermission(false)
  .addStringOption(opt =>
    opt
      .setName('periodo')
      .setDescription('Período de tempo')
      .setRequired(false)
      .addChoices(
        { name: 'Esta semana', value: 'week' },
        { name: 'Este mês', value: 'month' },
        { name: 'Total', value: 'total' }
      )
  );

// Semana começa na segunda: o fim de semana é quando o pessoal fica em call, e
// zerar no domingo cortaria a disputa no meio do rolê.
function startOfWeek(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return Math.floor(d.getTime() / 1000);
}

function startOfMonth(): number {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

const TITLE_SUFFIX: Record<string, string> = { week: ' (Semana)', month: ' (Mês)' };

// A consulta só soma sessões fechadas. Sem isto quem está na call agora aparece
// com o tempo congelado de quando entrou — o ranking fica errado exatamente
// enquanto as pessoas estão olhando pra ele.
function withLiveTime(guildId: string, rows: any[], since: number): any[] {
  const now = Math.floor(Date.now() / 1000);
  const byUser = new Map(rows.map((r) => [r.user_id, { ...r }]));
  for (const { userId, joinedAt } of listActiveSessions(guildId)) {
    const extra = now - Math.max(joinedAt, since);
    if (extra <= 0) continue;
    const existing = byUser.get(userId);
    if (existing) existing.total_seconds += extra;
  }
  return [...byUser.values()].sort((a, b) => b.total_seconds - a.total_seconds);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const period = interaction.options.getString('periodo') || 'total';
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Use este comando dentro de um servidor.', ephemeral: true });
    return;
  }

  let rows: any[];

  if (period === 'week' || period === 'month') {
    const since = period === 'week' ? startOfWeek() : startOfMonth();
    rows = withLiveTime(guildId, dbStatements.getLeaderboardSince.all(guildId, since) as any[], since);
  } else {
    rows = withLiveTime(guildId, dbStatements.getLeaderboard.all(guildId) as any[], 0);
  }

  if (rows.length === 0) {
    await interaction.reply(
      period === 'week'
        ? 'Ninguém entrou em call essa semana ainda. Vergonha.'
        : 'Ninguém tem horas registradas ainda.'
    );
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  // No ranking do período a soma é parcial, então o nível dali não seria o nível
  // real do usuário — só mostra no acumulado.
  const lines = rows.map((row, i) => {
    const prefix = medals[i] || `**${i + 1}.**`;
    const level = period === 'total' ? ` \`nv ${progressFor(row.total_seconds).level}\`` : '';
    return `${prefix} **${row.username}** — ${formatDuration(row.total_seconds)}${level}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle(`🏆 Leaderboard${TITLE_SUFFIX[period] ?? ''}`)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  if (period === 'week') embed.setFooter({ text: 'Zera toda segunda-feira' });

  await interaction.reply({ embeds: [embed] });
}
