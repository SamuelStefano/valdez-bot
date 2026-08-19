import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { hasOptedOut, setOptOut } from '../modules/guildSettings';
import { forgetUser, isBuffering } from '../modules/replayBuffer';
import { limits } from '../modules/licensing';
import { formatLabel } from '../modules/clipPublisher';

export const data = new SlashCommandBuilder()
  .setName('privacidade')
  .setDescription('Controla se a sua voz pode entrar no buffer de clips')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub.setName('optout').setDescription('Sua voz para de ser capturada e o que já estava no buffer é descartado')
  )
  .addSubcommand((sub) => sub.setName('optin').setDescription('Volta a permitir que sua voz entre nos clips'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Mostra o que o bot guarda da sua voz'));

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Use este comando dentro de um servidor.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;

  if (sub === 'optout') {
    setOptOut(guildId, userId, true);
    forgetUser(guildId, userId);
    await interaction.reply({
      content:
        '🔇 **Opt-out ativo.** Sua voz não entra mais no buffer e o que já estava guardado foi descartado agora.\n' +
        'Para voltar atrás: `/privacidade optin`.',
      ephemeral: true,
    });
    return;
  }

  if (sub === 'optin') {
    setOptOut(guildId, userId, false);
    await interaction.reply({
      content: '🎙️ **Opt-in.** Sua voz volta a entrar no buffer de clips a partir da próxima vez que você falar.',
      ephemeral: true,
    });
    return;
  }

  // A janela é o plano do servidor, não o teto do config: dizer "15 min" pra
  // quem tem 30s é errar por escrito justamente no texto de consentimento.
  const window = formatLabel(limits(guildId).bufferSeconds);
  const optedOut = hasOptedOut(guildId, userId);
  const embed = new EmbedBuilder()
    .setColor(optedOut ? 0x99aab5 : 0xed4245)
    .setTitle('🔒 Sua privacidade')
    .setDescription(
      optedOut
        ? 'Você está em **opt-out**: nada da sua voz é guardado.'
        : `Os últimos **${window}** da sua voz ficam **na memória do bot** e são descartados continuamente. ` +
            'Nada vai pra disco até alguém pedir um clip.'
    )
    .addFields(
      { name: 'Buffer ligado agora', value: isBuffering(guildId) ? 'sim' : 'não', inline: true },
      { name: 'Seu estado', value: optedOut ? '🔇 opt-out' : '🎙️ capturando', inline: true }
    )
    .setFooter({ text: 'O apelido do bot mostra [REC] sempre que ele está capturando.' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
