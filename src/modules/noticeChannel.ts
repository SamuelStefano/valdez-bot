import { ChannelType, Guild, PermissionFlagsBits, TextChannel } from 'discord.js';
import { getSettings } from './guildSettings';

// Canal do que o bot fala sozinho: prefere o canal de clips e só cai pro
// primeiro canal escrevível quando o admin ainda não configurou nada.
// SendMessages sozinho não basta: sem ViewChannel o envio falha mesmo com ela, e
// quem chama aqui posta embed (recap, cargos). Checando só a primeira, o bot
// escolhia um canal onde toda mensagem morria em erro.
const NEEDED = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

export function resolveNoticeChannel(guild: Guild): TextChannel | null {
  const me = guild.members.me;
  if (!me) return null;

  const configured = getSettings(guild.id).clipsChannelId;
  const target = configured ? guild.channels.cache.get(configured) : null;
  if (target?.isTextBased() && target.permissionsFor(me)?.has(NEEDED)) {
    return target as TextChannel;
  }

  const fallback = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.permissionsFor(me)?.has(NEEDED) === true
  );
  return (fallback as TextChannel) ?? null;
}
