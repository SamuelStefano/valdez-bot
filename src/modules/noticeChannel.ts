import { ChannelType, Guild, PermissionFlagsBits, TextChannel } from 'discord.js';
import { getSettings } from './guildSettings';

// SendMessages sozinho não basta: sem ViewChannel o envio falha mesmo com ela, e
// quem chama aqui posta embed (recap, cargos). Checando só a primeira, o bot
// escolhia um canal onde toda mensagem morria em erro.
const NEEDED = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

function usable(guild: Guild, channelId: string | null): TextChannel | null {
  const me = guild.members.me;
  if (!me || !channelId) return null;
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return null;
  return channel.permissionsFor(me)?.has(NEEDED) ? (channel as TextChannel) : null;
}

// Canal do que o bot fala sozinho. Sem canal escolhido ele fica calado: cair no
// primeiro canal escrevível era como o bot acabava despejando recap e cargo no
// meio de qualquer conversa, sem ninguém ter pedido.
export function resolveNoticeChannel(guild: Guild): TextChannel | null {
  const settings = getSettings(guild.id);
  return usable(guild, settings.noticesChannelId) ?? usable(guild, settings.clipsChannelId);
}

// Cobrança vencida é a única coisa que o dono precisa ver mesmo sem ter
// configurado canal nenhum — some daqui e ele descobre a assinatura morta pelo
// bot que parou de funcionar.
export function resolveBillingChannel(guild: Guild): TextChannel | null {
  const me = guild.members.me;
  if (!me) return null;
  const configured = resolveNoticeChannel(guild);
  if (configured) return configured;

  const fallback = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.permissionsFor(me)?.has(NEEDED) === true
  );
  return (fallback as TextChannel) ?? null;
}
