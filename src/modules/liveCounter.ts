import { Client, EmbedBuilder, Message, TextChannel } from 'discord.js';
import { getSettings } from './guildSettings';
import { resolveNoticeChannel } from './noticeChannel';
import { limits, isActive } from './licensing';
import { listActiveSessions, formatDuration } from './voiceTracker';
import { getActiveRecordings } from './replayBuffer';
import { config } from '../config';
import { logger } from '../utils/logger';

const REFRESH_MS = 60_000;
const COLOR = 0xff4d3d;

interface Counter {
  message: Message;
  voiceChannelId: string;
  startedAt: number;
}

const counters = new Map<string, Counter>();

function resolveTextChannel(client: Client, guildId: string): TextChannel | null {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  return resolveNoticeChannel(guild);
}

function render(client: Client, guildId: string, counter: Counter, closed: boolean): EmbedBuilder {
  const guild = client.guilds.cache.get(guildId);
  const now = Math.floor(Date.now() / 1000);
  const sessions = listActiveSessions(guildId);

  const lines = sessions.map((s) => {
    const member = guild?.members.cache.get(s.userId);
    const name = member ? member.displayName : `<@${s.userId}>`;
    return `\`${formatDuration(now - s.joinedAt).padEnd(11)}\` ${name}`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(closed ? '⏱️ Call encerrada' : '⏱️ Call ao vivo')
    .setDescription(
      lines.length > 0
        ? lines.join('\n')
        : 'Ninguém na call agora.'
    )
    .addFields({
      name: 'Duração da call',
      value: formatDuration(now - counter.startedAt),
      inline: true,
    });

  // Quem entra no meio da call não viu o /replay start. Sem isso, a única pista
  // de que está sendo gravado é o [REC] no apelido do bot.
  const recording = [...getActiveRecordings(guildId).values()][0];
  if (!closed && recording) {
    const elapsed = Math.floor((Date.now() - recording.startedAt) / 1000);
    embed.addFields({
      name: '🔴 Gravando',
      value: `${formatDuration(elapsed)} de ${formatDuration(config.maxRecordingSeconds)}`,
      inline: true,
    });
  }

  return embed
    .setFooter({ text: closed ? 'Valdez • /horas para o seu total' : 'Valdez • atualiza a cada minuto' })
    .setTimestamp();
}

function enabled(guildId: string): boolean {
  return getSettings(guildId).liveCounter && limits(guildId).stats && isActive(guildId);
}

// A trava entra antes do await do send: duas pessoas entrando na call dentro do
// tempo de ida e volta do Discord postavam dois contadores, e o primeiro ficava
// congelado no canal pra sempre.
const opening = new Set<string>();

async function open(client: Client, guildId: string, voiceChannelId: string): Promise<void> {
  if (opening.has(guildId) || counters.has(guildId)) return;
  opening.add(guildId);
  const channel = resolveTextChannel(client, guildId);
  if (!channel) {
    opening.delete(guildId);
    return;
  }

  const counter: Counter = {
    message: null as unknown as Message,
    voiceChannelId,
    startedAt: Math.floor(Date.now() / 1000),
  };

  try {
    counter.message = await channel.send({ embeds: [render(client, guildId, counter, false)] });
    counters.set(guildId, counter);
  } catch (err: any) {
    logger.warn(`[COUNTER] ${guildId}: não consegui postar: ${err?.message}`);
  } finally {
    opening.delete(guildId);
  }
}

async function refresh(client: Client, guildId: string, counter: Counter): Promise<void> {
  try {
    await counter.message.edit({ embeds: [render(client, guildId, counter, false)] });
  } catch (err: any) {
    // Apagaram a mensagem: para de tentar em vez de logar o mesmo erro pra sempre.
    logger.warn(`[COUNTER] ${guildId}: mensagem sumiu (${err?.message})`);
    counters.delete(guildId);
  }
}

async function close(client: Client, guildId: string): Promise<void> {
  const counter = counters.get(guildId);
  if (!counter) return;
  counters.delete(guildId);
  try {
    await counter.message.edit({ embeds: [render(client, guildId, counter, true)] });
  } catch {
    /* mensagem já não existe */
  }
}

// A call esvaziou quando não sobrou nenhum humano no canal que o bot acompanha.
function humansIn(client: Client, guildId: string, voiceChannelId: string): number {
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(voiceChannelId);
  if (!channel?.isVoiceBased()) return 0;
  return channel.members.filter((m) => !m.user.bot).size;
}

export function setupLiveCounter(client: Client): void {
  client.on('voiceStateUpdate', (oldState, newState) => {
    const guildId = newState.guild.id;
    if (newState.member?.user.bot || oldState.member?.user.bot) return;

    const voiceChannelId = newState.channelId ?? oldState.channelId;
    if (!voiceChannelId) return;

    const existing = counters.get(guildId);
    if (existing) {
      if (humansIn(client, guildId, existing.voiceChannelId) === 0) void close(client, guildId);
      else void refresh(client, guildId, existing);
      return;
    }

    if (!enabled(guildId)) return;
    if (humansIn(client, guildId, voiceChannelId) === 0) return;
    void open(client, guildId, voiceChannelId);
  });

  setInterval(() => {
    for (const [guildId, counter] of counters) {
      if (humansIn(client, guildId, counter.voiceChannelId) === 0) void close(client, guildId);
      else void refresh(client, guildId, counter);
    }
  }, REFRESH_MS);

  logger.info(`[COUNTER] contador ao vivo a cada ${REFRESH_MS / 1000}s`);
}

// Desligar pelo /config precisa tirar a mensagem da tela na hora, senão ela fica
// congelada no canal até a call acabar.
export function stopLiveCounter(client: Client, guildId: string): void {
  void close(client, guildId);
}

export function dropGuildCounter(guildId: string): void {
  counters.delete(guildId);
  opening.delete(guildId);
}
