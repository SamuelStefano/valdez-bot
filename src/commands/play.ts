import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { addTracks } from '../modules/musicPlayer';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Toca uma música, playlist ou álbum (YouTube ou Spotify)')
  .addStringOption(opt =>
    opt.setName('musica').setDescription('Nome, URL de vídeo, playlist ou álbum').setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const query = interaction.options.getString('musica', true);
  const guildId = interaction.guildId!;

  await interaction.deferReply();

  const result = await addTracks(guildId, query, interaction.user.displayName);

  if (!result || result.tracks.length === 0) {
    await interaction.editReply('❌ Não encontrei nada — verifique a URL ou tente outro termo.');
    return;
  }

  // Playlist / album
  if (result.playlistName) {
    const first = result.tracks[0];
    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setTitle(`📚 ${result.source === 'spotify' ? 'Spotify' : 'YouTube'} — adicionado à fila`)
      .setDescription(`**${result.playlistName}**\nIniciando com **${first.title}**`)
      .addFields(
        { name: 'Tracks resolvidas', value: String(result.tracks.length), inline: true },
        { name: 'Pedido por', value: first.requestedBy, inline: true }
      )
      .setFooter({ text: 'O restante da playlist é resolvido em background.' })
      .setTimestamp();

    if (first.thumbnail) embed.setThumbnail(first.thumbnail);

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // Single track
  const track = result.tracks[0];
  const embed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle('🎵 Adicionado à fila')
    .setDescription(`**[${track.title}](${track.url})**`)
    .addFields(
      { name: 'Duração', value: track.duration, inline: true },
      { name: 'Pedido por', value: track.requestedBy, inline: true }
    )
    .setTimestamp();

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);

  await interaction.editReply({ embeds: [embed] });
}
