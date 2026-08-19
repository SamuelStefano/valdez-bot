import { ChannelType, EmbedBuilder, Guild, PermissionFlagsBits, TextChannel } from 'discord.js';
import { logger } from '../utils/logger';
import { limits } from './licensing';
import { formatLabel } from './clipPublisher';

// Primeiro canal de texto onde o bot consegue falar. Sem isso o admin entra num
// servidor mudo e não descobre que precisa rodar /config.
const NEEDED = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

function firstWritableChannel(guild: Guild): TextChannel | null {
  const me = guild.members.me;
  if (!me) return null;

  const systemChannel = guild.systemChannel;
  if (systemChannel?.permissionsFor(me)?.has(NEEDED)) return systemChannel;

  const channel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.permissionsFor(me)?.has(NEEDED) === true
  );
  return (channel as TextChannel) ?? null;
}

export async function sendOnboarding(guild: Guild): Promise<void> {
  const channel = firstWritableChannel(guild);
  if (!channel) {
    logger.warn(`[ONBOARD] ${guild.id}: nenhum canal de texto disponível`);
    return;
  }

  const window = formatLabel(limits(guild.id).bufferSeconds);
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
      { name: '3. Usar', value: `\`/clip\` — salva os últimos minutos (até ${window})`, inline: false },
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
