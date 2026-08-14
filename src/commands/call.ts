import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { setPresence, isPresenceEnabled, isConnected } from '../modules/voiceManager';
import { isConfigured } from '../modules/guildSettings';

export const data = new SlashCommandBuilder()
  .setName('call')
  .setDescription('Controla a presença automática do Valdez na call')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand(sub => sub.setName('entrar').setDescription('Reativa a presença automática (entra quando tiver gente)'))
  .addSubcommand(sub => sub.setName('sair').setDescription('Desativa a presença automática e sai da call'))
  .addSubcommand(sub => sub.setName('status').setDescription('Mostra o estado da presença'));

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Use este comando dentro de um servidor.', ephemeral: true });
    return;
  }

  if (!isConfigured(guildId)) {
    await interaction.reply({
      content: '⚠️ Nenhum canal de voz configurado. Use `/config canal` primeiro.',
      ephemeral: true,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    if (!isPresenceEnabled(guildId)) {
      await interaction.reply({ content: '⚪ Presença automática **desativada** — fico fora até `/call entrar`.', ephemeral: true });
    } else {
      await interaction.reply({
        content: isConnected(guildId)
          ? '🟢 Presença automática **ativa** — estou na call.'
          : '🟡 Presença automática **ativa** — call vazia, entro quando alguém chegar.',
        ephemeral: true,
      });
    }
    return;
  }

  if (sub === 'entrar') {
    await setPresence(interaction.client, guildId, true);
    await interaction.reply({ content: '🟢 Presença automática reativada — entro quando tiver gente na call.', ephemeral: true });
    return;
  }

  if (sub === 'sair') {
    await setPresence(interaction.client, guildId, false);
    await interaction.reply({ content: '⚪ Presença automática desativada — saí e não volto até `/call entrar`.', ephemeral: true });
    return;
  }
}
