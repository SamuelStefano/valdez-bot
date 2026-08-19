import { Client, TextChannel, VoiceState } from 'discord.js';
import { getSettings } from './guildSettings';
import { limits, isActive } from './licensing';
import { formatDuration } from './voiceTracker';
import { logger } from '../utils/logger';

// Trocar de canal, cair a internet e voltar, ou o Discord reemitir o estado
// geram entra-e-sai em segundos. Sem essa janela o canal de texto vira spam e o
// admin desliga o recurso inteiro.
const DEBOUNCE_MS = 90_000;

// Abaixo disso a pessoa passou na call, não participou dela — anunciar a saída
// só polui.
const MIN_STAY_SECONDS = 60;

const lastAnnounced = new Map<string, number>();

// O horário de entrada é guardado aqui em vez de vir do voiceTracker: os dois
// escutam o mesmo evento e o tracker já apagou a sessão quando este handler roda.
const joinedAt = new Map<string, number>();

function recentlyAnnounced(key: string): boolean {
  const last = lastAnnounced.get(key) ?? 0;
  if (Date.now() - last < DEBOUNCE_MS) return true;
  lastAnnounced.set(key, Date.now());
  return false;
}

function resolveTextChannel(client: Client, guildId: string): TextChannel | null {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  const clipsChannelId = getSettings(guildId).clipsChannelId;
  const clips = clipsChannelId ? guild.channels.cache.get(clipsChannelId) : null;
  if (clips?.isTextBased()) return clips as TextChannel;
  return guild.systemChannel ?? null;
}

function humansIn(client: Client, guildId: string, voiceChannelId: string): number {
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(voiceChannelId);
  if (!channel?.isVoiceBased()) return 0;
  return channel.members.filter((m) => !m.user.bot).size;
}

async function say(client: Client, guildId: string, content: string): Promise<void> {
  const channel = resolveTextChannel(client, guildId);
  if (!channel) return;
  try {
    await channel.send({ content, allowedMentions: { parse: [] } });
  } catch (err: any) {
    logger.warn(`[AVISO] ${guildId}: não consegui postar: ${err?.message}`);
  }
}

function enabled(guildId: string): boolean {
  return getSettings(guildId).announce && limits(guildId).stats && isActive(guildId);
}

export function setupCallAnnounce(client: Client): void {
  client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    const guildId = newState.guild.id;
    if (!enabled(guildId)) return;

    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;

    const target = getSettings(guildId).voiceChannelId;
    if (!target) return;

    const joined = oldState.channelId !== target && newState.channelId === target;
    const left = oldState.channelId === target && newState.channelId !== target;
    if (!joined && !left) return;

    const key = `${guildId}:${member.id}`;
    const name = member.displayName;

    if (joined) {
      joinedAt.set(key, Date.now());
      if (recentlyAnnounced(key)) return;
      // Quem abre a call é o aviso que faz alguém largar o que está fazendo pra
      // entrar; do segundo em diante já tem gente lá e a mensagem vale menos.
      const first = humansIn(client, guildId, target) <= 1;
      void say(
        client,
        guildId,
        first ? `🎉 **${name}** abriu a call — bora?` : `🟢 **${name}** entrou na call.`
      );
      return;
    }

    const since = joinedAt.get(key);
    joinedAt.delete(key);
    const stay = since ? Math.floor((Date.now() - since) / 1000) : 0;
    const remaining = humansIn(client, guildId, target);

    if (remaining === 0) {
      lastAnnounced.delete(key);
      void say(client, guildId, `💤 A call acabou. **${name}** foi o último a sair.`);
      return;
    }

    if (stay < MIN_STAY_SECONDS) return;
    void say(client, guildId, `🔴 **${name}** saiu da call — ficou ${formatDuration(stay)}.`);
  });

  logger.info('[AVISO] avisos de entrada e saída ativos');
}

export function dropGuildAnnounce(guildId: string): void {
  const prefix = `${guildId}:`;
  for (const key of lastAnnounced.keys()) {
    if (key.startsWith(prefix)) {
      lastAnnounced.delete(key);
      joinedAt.delete(key);
    }
  }
}
