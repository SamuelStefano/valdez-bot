import { Client, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger';
import { config } from '../config';

// Gravar voz sem aviso visível é indefensável — e é o que o bot fazia. O padrão
// aqui é o do Craig: o indicador no apelido é condição para bufferizar. Se o bot
// não consegue exibir que está capturando, ele não captura.
const REC_PREFIX = '[REC] ';

export async function showRecordingIndicator(client: Client, guildId: string): Promise<boolean> {
  const guild = client.guilds.cache.get(guildId);
  const me = guild?.members.me;
  if (!guild || !me) return false;

  if (!me.permissions.has(PermissionFlagsBits.ChangeNickname)) {
    logger.warn(`[CONSENT] ${guildId}: sem permissão ChangeNickname — buffer não será ligado`);
    return false;
  }

  const current = me.nickname ?? me.user.username;
  if (current.startsWith(REC_PREFIX)) return true;

  try {
    await me.setNickname(`${REC_PREFIX}${current}`.slice(0, 32));
    return true;
  } catch (err: any) {
    logger.warn(`[CONSENT] ${guildId}: falha ao marcar apelido: ${err?.message}`);
    return false;
  }
}

export async function clearRecordingIndicator(client: Client, guildId: string): Promise<void> {
  const me = client.guilds.cache.get(guildId)?.members.me;
  if (!me?.nickname?.startsWith(REC_PREFIX)) return;

  const stripped = me.nickname.slice(REC_PREFIX.length);
  try {
    await me.setNickname(stripped === me.user.username ? null : stripped);
  } catch (err: any) {
    logger.warn(`[CONSENT] ${guildId}: falha ao limpar apelido: ${err?.message}`);
  }
}

export async function announceBuffering(client: Client, guildId: string, channelId: string): Promise<void> {
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;

  const minutes = Math.round(config.replayBufferSeconds / 60);
  try {
    await channel.send(
      `🔴 **Buffer de clip ligado.** Os últimos **${minutes} min** de voz ficam na memória do bot ` +
        `para quem pedir um clip, e são descartados continuamente — nada é gravado em disco sem alguém pedir.\n` +
        `Não quer ser capturado? \`/privacidade optout\` — sua voz deixa de entrar no buffer na hora.`
    );
  } catch (err: any) {
    logger.warn(`[CONSENT] ${guildId}: falha ao avisar no canal: ${err?.message}`);
  }
}
