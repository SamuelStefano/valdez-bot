import { Client, EmbedBuilder, Guild } from 'discord.js';
import { dbStatements } from '../utils/database';
import { limits, isActive } from './licensing';
import { resolveNoticeChannel } from './noticeChannel';
import { listActiveSessions, formatDuration } from './voiceTracker';
import { pickAwards, Participant } from './callAwards';
import { track } from './telemetry';
import { logger } from '../utils/logger';

// Call de 5 minutos não rende recap: postar um card por qualquer entrada e saída
// transforma o canal de clips em log.
const MIN_RECAP_SECONDS = 600;
const MAX_LINES = 10;
const COLOR = 0xfaa61a;

interface Call {
  startedAt: number;
  voiceChannelId: string;
}

interface ParticipantRow {
  user_id: string;
  username: string;
  total_seconds: number;
  first_join: number;
  last_left: number;
}

const calls = new Map<string, Call>();

// O início vem de quem já está na call, não do relógio: reconexão, rejoin do
// watchdog e restart do bot chamam isso no meio do rolê, e usar "agora" zeraria
// a duração toda vez.
export function beginCall(guildId: string, voiceChannelId: string): void {
  const sessions = listActiveSessions(guildId);
  const startedAt = sessions.length > 0 ? sessions[0].joinedAt : Math.floor(Date.now() / 1000);
  calls.set(guildId, { startedAt, voiceChannelId });
}

export function dropCall(guildId: string): void {
  calls.delete(guildId);
}

async function publish(guild: Guild, call: Call, endedAt: number): Promise<void> {
  const guildId = guild.id;
  const durationSeconds = endedAt - call.startedAt;
  if (durationSeconds < MIN_RECAP_SECONDS) return;

  const rows = dbStatements.sessionParticipants.all(
    guildId,
    call.voiceChannelId,
    call.startedAt
  ) as ParticipantRow[];
  // Call de uma pessoa só não é rolê pra ter card de resumo.
  if (rows.length < 2) return;

  const participants: Participant[] = rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    seconds: r.total_seconds,
    firstJoin: r.first_join,
    lastLeft: r.last_left,
  }));

  const clipRows = dbStatements.sessionClips.all(guildId, call.startedAt) as {
    user_id: string | null;
    n: number;
  }[];
  const clipsByUser = new Map<string, number>();
  let totalClips = 0;
  for (const row of clipRows) {
    totalClips += row.n;
    if (row.user_id) clipsByUser.set(row.user_id, row.n);
  }

  const channel = resolveNoticeChannel(guild);
  if (!channel) return;

  const medals = ['🥇', '🥈', '🥉'];
  const lines = participants
    .slice(0, MAX_LINES)
    .map((p, i) => `${medals[i] ?? '▫️'} \`${formatDuration(p.seconds).padEnd(11)}\` ${p.username}`);
  if (participants.length > MAX_LINES) {
    lines.push(`_+${participants.length - MAX_LINES} que passaram por aqui_`);
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🎬 Acabou a call')
    .setDescription(`Durou **${formatDuration(durationSeconds)}** com **${participants.length} pessoas**.`)
    .addFields(
      { name: 'Quem estava', value: lines.join('\n') },
      {
        name: 'Clips salvos',
        value: totalClips === 0 ? 'nenhum — ninguém achou nada engraçado 💀' : `**${totalClips}**`,
        inline: true,
      }
    );

  const awards = pickAwards({ participants, durationSeconds, clipsByUser });
  if (awards.length > 0) embed.addFields({ name: '🏆 Prêmios da call', value: awards.join('\n') });

  embed.setFooter({ text: 'Valdez • /leaderboard pra ver o ranking' }).setTimestamp();

  await channel.send({ embeds: [embed] });
  track(guildId, 'recap', { seconds: durationSeconds, detail: `${participants.length}p/${totalClips}c` });
}

export function endCall(client: Client, guildId: string): void {
  const call = calls.get(guildId);
  calls.delete(guildId);
  if (!call) return;
  if (!limits(guildId).stats || !isActive(guildId)) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  publish(guild, call, Math.floor(Date.now() / 1000)).catch((err: any) => {
    logger.warn(`[RECAP] ${guildId}: falha ao postar: ${err?.message}`);
  });
}
