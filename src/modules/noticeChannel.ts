import { ChannelType, Guild, PermissionFlagsBits, TextChannel } from 'discord.js';
import { getSettings } from './guildSettings';

// Canal do que o bot fala sozinho: prefere o canal de clips e só cai pro
// primeiro canal escrevível quando o admin ainda não configurou nada.
export function resolveNoticeChannel(guild: Guild): TextChannel | null {
  const me = guild.members.me;
  if (!me) return null;

  const configured = getSettings(guild.id).clipsChannelId;
  const target = configured ? guild.channels.cache.get(configured) : null;
  if (target?.isTextBased() && target.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
    return target as TextChannel;
  }

  const fallback = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) === true
  );
  return (fallback as TextChannel) ?? null;
}
