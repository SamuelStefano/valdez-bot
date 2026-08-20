import { Client, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger';
import { limits } from './licensing';
import { formatLabel } from './clipPublisher';
import { dbStatements } from '../utils/database';

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

  // Cortar o resultado em 32 destruía o apelido original: ao tirar o [REC] o que
  // voltava era o nome já truncado, e a perda era definitiva.
  const room = 32 - REC_PREFIX.length;
  if (current.length > room) {
    logger.warn(`[CONSENT] ${guildId}: apelido longo demais pro [REC] — buffer não será ligado`);
    return false;
  }

  try {
    await me.setNickname(`${REC_PREFIX}${current}`);
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

// O aviso é de consentimento, não de status da conexão: ele repetia a cada
// rejoin, e o bot rejoina toda vez que a call esvazia por um minuto ou que o
// container reinicia. A janela mora no banco justamente pra sobreviver ao
// restart — o [REC] no apelido é quem mostra o estado o tempo todo.
const ANNOUNCE_COOLDOWN_SECONDS = 12 * 60 * 60;

function announceKey(guildId: string): string {
  return `consent_announced:${guildId}`;
}

function announcedRecently(guildId: string): boolean {
  const row = dbStatements.getMeta.get(announceKey(guildId)) as { value: number } | undefined;
  if (!row) return false;
  return Math.floor(Date.now() / 1000) - Number(row.value) < ANNOUNCE_COOLDOWN_SECONDS;
}

export async function announceBuffering(client: Client, guildId: string, channelId: string): Promise<void> {
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;
  if (announcedRecently(guildId)) return;

  const window = formatLabel(limits(guildId).bufferSeconds);
  try {
    await channel.send(
      `🔴 **Buffer de clip ligado.** Os últimos **${window}** de voz ficam na memória do bot ` +
        `para quem pedir um clip, e são descartados continuamente — nada é gravado em disco sem alguém pedir.\n` +
        `Não quer ser capturado? \`/privacidade optout\` — sua voz deixa de entrar no buffer na hora.`
    );
    dbStatements.setMeta.run(announceKey(guildId), Math.floor(Date.now() / 1000));
  } catch (err: any) {
    logger.warn(`[CONSENT] ${guildId}: falha ao avisar no canal: ${err?.message}`);
  }
}
