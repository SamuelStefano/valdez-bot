import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { addTrack } from '../modules/musicPlayer';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Toca uma música do YouTube ou Spotify')
  .addStringOption(opt =>
    opt.setName('musica').setDescription('Nome ou URL da música').setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const query = interaction.options.getString('musica', true);
  const guildId = interaction.guildId!;

  await interaction.deferReply();

  const track = await addTrack(guildId, query, interaction.user.displayName);

  if (!track) {
    await interaction.editReply('❌ Não encontrei essa música.');
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle('🎵 Adicionado à fila')
    .setDescription(`**[${track.title}](${track.url})**`)
    .addFields(
      { name: 'Duração', value: track.duration, inline: true },
      { name: 'Pedido por', value: track.requestedBy, inline: true }
    )
    .setTimestamp();

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  await interaction.editReply({ embeds: [embed] });
}
