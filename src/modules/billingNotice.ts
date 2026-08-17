import { Client, EmbedBuilder } from 'discord.js';
import { getLicense, PLANS, founderSlotsLeft } from './licensing';
import { resolveNoticeChannel } from './noticeChannel';
import { track } from './telemetry';
import { config } from '../config';
import { logger } from '../utils/logger';

// Um aviso por processo por servidor: a avaliação de presença roda a cada
// entrada na call e transformaria o vencimento em spam.
const notified = new Set<string>();

export async function announceExpired(client: Client, guildId: string): Promise<void> {
  if (notified.has(guildId)) return;
  notified.add(guildId);

  const license = getLicense(guildId);
  track(guildId, 'license_expired', { detail: license.plan });

  const guild = client.guilds.cache.get(guildId);
  const channel = guild ? resolveNoticeChannel(guild) : null;
  if (!channel) return;

  const slots = founderSlotsLeft();
  const embed = new EmbedBuilder()
    .setColor(0x99aab5)
    .setTitle('⏳ Assinatura vencida')
    .setDescription(
      'Continuo na call, mas agora só seguro os **últimos 30 segundos**. Dá pra salvar a risada, ' +
        'não dá pra salvar a história que veio antes dela. Nada seu foi perdido — reativando, volto ao normal na hora.'
    )
    .addFields(
      { name: PLANS.basic.label, value: 'R$ 10/mês — buffer de 1min30', inline: true },
      { name: PLANS.pro.label, value: 'R$ 30/mês — buffer de 15 min + gravação', inline: true },
      { name: PLANS.max.label, value: 'R$ 50/mês — buffer de 30 min', inline: true },
      { name: PLANS.lifetime.label, value: 'R$ 150 uma vez — tudo do Pro, sem mensalidade' }
    )
    .setFooter({
      text: slots > 0 ? `Restam ${slots} vagas de fundador a R$ 10 para sempre.` : 'Use /assinatura para reativar.',
    });

  if (config.siteUrl) embed.setURL(config.siteUrl);

  try {
    await channel.send({ embeds: [embed] });
  } catch (err: any) {
    logger.warn(`[BILLING] ${guildId}: falha ao avisar vencimento: ${err?.message}`);
  }
}

export function clearExpiredNotice(guildId: string): void {
  notified.delete(guildId);
}
