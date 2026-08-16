import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { dbStatements } from '../utils/database';
import { logger } from '../utils/logger';

const DAILY_LIMIT = 3;

export const data = new SlashCommandBuilder()
  .setName('feedback')
  .setDescription('Manda um recado direto pro dono do bot')
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName('mensagem')
      .setDescription('O que faltou, o que quebrou, o que você queria que tivesse')
      .setRequired(true)
      .setMaxLength(1000)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('nota')
      .setDescription('De 1 a 5, o quanto o bot te atende hoje')
      .addChoices(
        { name: '⭐', value: 1 },
        { name: '⭐⭐', value: 2 },
        { name: '⭐⭐⭐', value: 3 },
        { name: '⭐⭐⭐⭐', value: 4 },
        { name: '⭐⭐⭐⭐⭐', value: 5 }
      )
  )
  // Depoimento no site é dado pessoal saindo do Discord. Pedir aqui é a única
  // forma de publicar sem trair quem só queria reclamar de um bug em particular.
  .addBooleanOption((opt) =>
    opt
      .setName('publicar')
      .setDescription('Deixa eu usar seu recado no site do Valdez, com seu nome do Discord')
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Use este comando dentro de um servidor.', ephemeral: true });
    return;
  }

  // Sem teto, um usuário irritado enche o painel sozinho e some com o feedback
  // dos outros servidores.
  const since = Math.floor(Date.now() / 1000) - 86400;
  const { n } = dbStatements.recentFeedbackByUser.get(interaction.user.id, since) as { n: number };
  if (n >= DAILY_LIMIT) {
    await interaction.reply({
      content: `⚠️ Você já mandou ${DAILY_LIMIT} feedbacks hoje. Tenta de novo amanhã.`,
      ephemeral: true,
    });
    return;
  }

  const canPublish = interaction.options.getBoolean('publicar') ?? false;

  try {
    dbStatements.addFeedback.run({
      guild_id: guildId,
      guild_name: interaction.guild?.name ?? null,
      user_id: interaction.user.id,
      username: interaction.user.username,
      rating: interaction.options.getInteger('nota'),
      message: interaction.options.getString('mensagem', true),
      created_at: Math.floor(Date.now() / 1000),
      can_publish: canPublish ? 1 : 0,
    });
  } catch (err: any) {
    logger.error(`[FEEDBACK] ${guildId}: falha ao gravar: ${err?.message}`);
    await interaction.reply({ content: '❌ Não consegui guardar seu feedback. Tenta de novo.', ephemeral: true });
    return;
  }

  await interaction.reply({
    content:
      '✅ Recebido, valeu! Leio todos — se for bug, costumo consertar na mesma semana.' +
      (canPublish ? '\n*Posso publicar esse recado no site. Se mudar de ideia, é só me chamar.*' : ''),
    ephemeral: true,
  });
}
