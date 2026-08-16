import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import {
  PLANS,
  SUPPORT_LABEL,
  getLicense,
  limits,
  daysLeft,
  founderSlotsLeft,
  lifetimeSlotsLeft,
  LIFETIME_SLOTS,
} from '../modules/licensing';
import type { MusicTier } from '../modules/licensing';
import { formatLabel } from '../modules/clipPublisher';
import { config } from '../config';

const MUSIC_LABEL: Record<MusicTier, string> = {
  none: 'não',
  link: 'por link ou nome',
  playlist: 'playlist e álbum inteiros',
};

export const data = new SlashCommandBuilder()
  .setName('assinatura')
  .setDescription('Mostra o plano deste servidor e como assinar')
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Use este comando dentro de um servidor.', ephemeral: true });
    return;
  }

  const license = getLicense(guildId);
  const plan = limits(guildId);
  const restam = daysLeft(license);
  const slots = founderSlotsLeft();

  const statusLine =
    license.status !== 'active'
      ? '⚠️ **Vencido** — rodando no gratuito, com 30s de buffer.'
      : restam === null
        ? '✅ Ativo'
        : `✅ Ativo — restam **${restam} dia(s)**`;

  const embed = new EmbedBuilder()
    .setColor(license.status === 'active' ? 0x57f287 : 0xed4245)
    // plan já vem do limits(), que devolve o gratuito quando não há licença ativa
    // — o título mostra o que o servidor tem agora, não o que ele já teve.
    .setTitle(`Plano: ${plan.label}${license.founder ? ' • Fundador' : ''}`)
    .setDescription(statusLine)
    .addFields(
      {
        name: 'O que este plano libera',
        value: [
          `• Buffer de **${formatLabel(plan.bufferSeconds)}**`,
          `• Clip de até **${formatLabel(plan.maxClipSeconds)}**`,
          `• Música: **${MUSIC_LABEL[plan.music]}**`,
          `• Gravação contínua: ${plan.replay ? 'sim' : 'não'}`,
          `• Canal de clipes dedicado: ${plan.clipsChannel ? 'sim' : 'não'}`,
          `• Contador na call + cargos por nível + recap: ${plan.stats ? 'sim' : 'não'}`,
          `• Clipe de uma voz só: ${plan.isolatedClip ? 'sim' : 'não'}`,
          `• Retrospectiva semanal: ${plan.weeklyRecap ? 'sim' : 'não'}`,
          `• Suporte: **${SUPPORT_LABEL[plan.support]}**`,
        ].join('\n'),
      },
      {
        name: `${PLANS.basic.label} — R$ 10/mês`,
        value: 'Clip de 1min30 e música por link. Suporte por ticket no site.',
        inline: true,
      },
      {
        name: `${PLANS.pro.label} — R$ 30/mês`,
        value:
          'Clip de 15 min, gravação contínua, playlist inteira, contador ao vivo na call, cargos por nível e recap de fim de call. Suporte no Discord.',
        inline: true,
      },
      {
        name: `${PLANS.max.label} — R$ 50/mês`,
        value:
          'Tudo do Pro, clip de 30 min, **clipe da voz de uma pessoa só** e retrospectiva semanal do servidor. Suporte no WhatsApp.',
        inline: true,
      },
      {
        name: `${PLANS.lifetime.label} — R$ 150 uma vez`,
        value: `Tudo do Pro, sem mensalidade nunca mais. Restam **${lifetimeSlotsLeft()}** de ${LIFETIME_SLOTS} vagas.`,
      }
    );

  if (slots > 0) {
    embed.addFields({
      name: '🏅 Preço de fundador',
      value: `Os **${slots}** próximos servidores travam **R$ 10/mês para sempre**, em qualquer plano.`,
    });
  }

  embed.setFooter({
    text: config.siteUrl ? 'Assine no site — leva 1 minuto por Pix.' : 'Fale com o dono do bot para assinar.',
  });
  if (config.siteUrl) embed.setURL(config.siteUrl);

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
