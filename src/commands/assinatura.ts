import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { PLANS, SUPPORT_LABEL, getLicense, limits, daysLeft, founderSlotsLeft } from '../modules/licensing';
import { formatLabel } from '../modules/clipPublisher';
import { config } from '../config';

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
      ? '⚠️ **Vencido** — o bot não entra mais na call.'
      : restam === null
        ? '✅ Ativo'
        : `✅ Ativo — restam **${restam} dia(s)**`;

  const embed = new EmbedBuilder()
    .setColor(license.status === 'active' ? 0x57f287 : 0xed4245)
    .setTitle(`Plano: ${plan.label}${license.founder ? ' • Fundador' : ''}`)
    .setDescription(statusLine)
    .addFields(
      {
        name: 'O que este plano libera',
        value: [
          `• Buffer de **${formatLabel(plan.bufferSeconds)}**`,
          `• Clip de até **${formatLabel(plan.maxClipSeconds)}**`,
          `• Gravação contínua: ${plan.replay ? 'sim' : 'não'}`,
          `• Canal de clipes dedicado: ${plan.clipsChannel ? 'sim' : 'não'}`,
          `• Suporte: **${SUPPORT_LABEL[plan.support]}**`,
        ].join('\n'),
      },
      {
        name: `${PLANS.basic.label} — R$ 10/mês`,
        value: 'Clip de 1min30, MP3 pra baixar. Suporte por ticket no site.',
        inline: true,
      },
      {
        name: `${PLANS.pro.label} — R$ 30/mês`,
        value: 'Clip de 15 min, gravação contínua, contador na call. Suporte no Discord.',
        inline: true,
      },
      {
        name: `${PLANS.max.label} — R$ 50/mês`,
        value: 'Clip de 30 min. Suporte no WhatsApp.',
        inline: true,
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
