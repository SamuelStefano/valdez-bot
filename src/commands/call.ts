import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { setPresence, isPresenceEnabled } from '../modules/voiceManager';

export const data = new SlashCommandBuilder()
  .setName('call')
  .setDescription('Controla se o Valdez fica na call')
  .addSubcommand(sub => sub.setName('entrar').setDescription('Entra na call e mantém presença'))
  .addSubcommand(sub => sub.setName('sair').setDescription('Sai da call e para de reconectar'))
  .addSubcommand(sub => sub.setName('status').setDescription('Mostra se a presença está ativa'));

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    await interaction.reply({
      content: isPresenceEnabled() ? '🟢 Presença **ativa** — o Valdez fica na call.' : '⚪ Presença **desativada** — o Valdez fica fora da call.',
      ephemeral: true,
    });
    return;
  }

  if (sub === 'entrar') {
    await interaction.deferReply({ ephemeral: true });
    await setPresence(interaction.client, true);
    await interaction.editReply('🟢 Entrando na call e mantendo presença.');
    return;
  }

  if (sub === 'sair') {
    await setPresence(interaction.client, false);
    await interaction.reply({ content: '⚪ Saí da call. Não vou reconectar até `/call entrar`.', ephemeral: true });
    return;
  }
}
