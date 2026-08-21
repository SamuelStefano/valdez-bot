import { Client, EmbedBuilder, Guild } from 'discord.js';
import { dbStatements } from '../utils/database';
import { limits, isActive } from './licensing';
import { resolveNoticeChannel } from './noticeChannel';
import { getSettings } from './guildSettings';
import { formatDuration } from './voiceTracker';
import { track } from './telemetry';
import { logger } from '../utils/logger';

const COLOR = 0xff4d3d;
const CHECK_INTERVAL_MS = 10 * 60_000;
// Segunda de manhã ninguém abre o Discord. Meio-dia é quando o servidor volta a
// ter gente pra ver o card, e o ranking da semana já zerou às 00h.
const POST_HOUR = 12;

interface Row {
  user_id: string;
  username: string;
  total_seconds: number;
}

// O processo roda com TZ=America/Sao_Paulo, então o relógio local já é o do
// público — a semana fecha na segunda brasileira, não na do UTC.
function startOfWeek(offsetWeeks = 0): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offsetWeeks * 7);
  return Math.floor(d.getTime() / 1000);
}

function buildEmbed(guild: Guild, from: number, to: number): EmbedBuilder | null {
  const totals = dbStatements.weekTotals.get(guild.id, from, to) as {
    people: number;
    sessions: number;
    seconds: number;
  };
  // Semana morta não vira card: postar "0 horas, 0 pessoas" toda segunda é o
  // jeito mais rápido de o admin desligar o bot.
  if (!totals || totals.people === 0 || totals.seconds === 0) return null;

  const rows = dbStatements.getLeaderboardBetween.all(guild.id, from, to) as Row[];
  const events = dbStatements.weekEvents.all(guild.id, from, to) as { kind: string; n: number }[];
  const byKind = new Map(events.map((e) => [e.kind, e.n]));
  const clips = (byKind.get('clip') ?? 0) + (byKind.get('replay') ?? 0);

  const medals = ['🥇', '🥈', '🥉'];
  const podium = rows
    .slice(0, 5)
    .map((r, i) => `${medals[i] ?? `**${i + 1}.**`} **${r.username}** — ${formatDuration(r.total_seconds)}`)
    .join('\n');

  const range = `${new Date(from * 1000).toLocaleDateString('pt-BR')} a ${new Date((to - 1) * 1000).toLocaleDateString('pt-BR')}`;

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`📅 A semana em ${guild.name}`)
    .setDescription(`Retrospectiva de ${range}.`)
    .addFields(
      { name: 'Tempo em call', value: formatDuration(totals.seconds), inline: true },
      { name: 'Gente na call', value: `${totals.people}`, inline: true },
      { name: 'Clipes salvos', value: `${clips}`, inline: true },
      { name: '🏆 Quem mais viveu ali', value: podium || '—' }
    )
    .setFooter({ text: 'Valdez • retrospectiva semanal do Máximo' })
    .setTimestamp();

  if (guild.iconURL()) embed.setThumbnail(guild.iconURL()!);
  return embed;
}

async function publish(guild: Guild): Promise<void> {
  const channel = resolveNoticeChannel(guild);
  if (!channel) return;

  const embed = buildEmbed(guild, startOfWeek(-1), startOfWeek());
  if (!embed) return;

  await channel.send({ embeds: [embed] });
  track(guild.id, 'weekly_recap');
}

function alreadyPosted(guildId: string): boolean {
  const { n } = dbStatements.countEventsSince.get(guildId, 'weekly_recap', startOfWeek()) as {
    n: number;
  };
  return n > 0;
}

async function tick(client: Client): Promise<void> {
  const now = new Date();
  if (now.getDay() !== 1 || now.getHours() < POST_HOUR) return;

  for (const guild of client.guilds.cache.values()) {
    // O try cobre a checagem também: uma exceção fora dele abortava a segunda
    // inteira, e todos os servidores da fila ficavam sem retrospectiva.
    try {
      if (!getSettings(guild.id).weeklyRecap) continue;
      if (!limits(guild.id).weeklyRecap || !isActive(guild.id)) continue;
      // O marcador é um evento no banco, não memória: restart de container numa
      // segunda à tarde repostaria a retrospectiva em todos os servidores.
      if (alreadyPosted(guild.id)) continue;
      await publish(guild);
    } catch (err: any) {
      logger.warn(`[WEEKLY] ${guild.id}: falha ao postar: ${err?.message}`);
    }
  }
}

export function startWeeklyRecap(client: Client): void {
  // Uma rodada lenta atravessando o intervalo faria duas varreduras lerem o mesmo
  // "ainda não postei" e a retrospectiva sair duplicada.
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    tick(client)
      .catch((err: any) => logger.warn(`[WEEKLY] rodada falhou: ${err?.message}`))
      .finally(() => {
        running = false;
      });
  }, CHECK_INTERVAL_MS);
  logger.info('[WEEKLY] retrospectiva semanal agendada (segunda, 12h)');
}
