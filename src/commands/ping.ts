import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Verifica se o Valdez está online');

export async function execute(interaction: ChatInputCommandInteraction) {
  const latency = Date.now() - interaction.createdTimestamp;
  await interaction.reply(`🏓 Pong! Latência: **${latency}ms**`);
}
