import { ChannelType, EmbedBuilder, Guild, PermissionFlagsBits, TextChannel } from 'discord.js';
import { logger } from '../utils/logger';
import { config } from '../config';

// Primeiro canal de texto onde o bot consegue falar. Sem isso o admin entra num
// servidor mudo e não descobre que precisa rodar /config.
function firstWritableChannel(guild: Guild): TextChannel | null {
  const me = guild.members.me;
  if (!me) return null;

  const systemChannel = guild.systemChannel;
  if (systemChannel?.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) return systemChannel;

  const channel = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) === true
  );
  return (channel as TextChannel) ?? null;
}

export async function sendOnboarding(guild: Guild): Promise<void> {
  const channel = firstWritableChannel(guild);
  if (!channel) {
    logger.warn(`[ONBOARD] ${guild.id}: nenhum canal de texto disponível`);
    return;
  }

  const minutes = Math.round(config.replayBufferSeconds / 60);
  const embed = new EmbedBuilder()
    .setColor(0xff4d4d)
    .setTitle('👋 Valdez chegou')
    .setDescription(
      'Eu guardo os últimos minutos da call **na memória** e transformo em clip quando alguém pede. ' +
        'Nada vai pra disco sem `/clip`.'
    )
    .addFields(
      { name: '1. Configurar', value: '`/config canal` — o canal de voz que eu acompanho', inline: false },
      { name: '2. Onde postar', value: '`/config clips` — o canal de texto dos clips (opcional)', inline: false },
      { name: '3. Usar', value: `\`/clip\` — salva os últimos minutos (até ${minutes})`, inline: false },
      {
        name: 'Privacidade',
        value:
          'Enquanto eu capturo, meu apelido mostra `[REC]`. Qualquer membro pode sair com `/privacidade optout`.',
        inline: false,
      }
    )
    .setFooter({ text: 'Só quem tem Gerenciar Servidor consegue rodar /config.' });

  try {
    await channel.send({ embeds: [embed] });
  } catch (err: any) {
    logger.warn(`[ONBOARD] ${guild.id}: falha ao enviar: ${err?.message}`);
  }
}
