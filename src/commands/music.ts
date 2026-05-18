import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { skip, stop, pause, resume, toggleLoop, getQueue, nowPlaying, previous } from '../modules/musicPlayer';

export const data = new SlashCommandBuilder()
  .setName('music')
  .setDescription('Controles de música')
  .addSubcommand(sub => sub.setName('skip').setDescription('Pula a música atual'))
  .addSubcommand(sub => sub.setName('previous').setDescription('Volta para a música anterior'))
  .addSubcommand(sub => sub.setName('stop').setDescription('Para a música e limpa a fila'))
  .addSubcommand(sub => sub.setName('pause').setDescription('Pausa a música'))
  .addSubcommand(sub => sub.setName('resume').setDescription('Retoma a música'))
  .addSubcommand(sub => sub.setName('loop').setDescription('Ativa/desativa loop'))
  .addSubcommand(sub => sub.setName('queue').setDescription('Mostra a fila de músicas'))
  .addSubcommand(sub => sub.setName('np').setDescription('Mostra a música atual'));

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId!;

  switch (sub) {
    case 'skip': {
      const skipped = skip(guildId);
      if (skipped) {
        await interaction.reply(`⏭️ Pulou: **${skipped.title}**`);
      } else {
        await interaction.reply({ content: '❌ Nada tocando.', ephemeral: true });
      }
      break;
    }

    case 'previous': {
      const prev = previous(guildId);
      if (prev) {
        await interaction.reply(`⏮️ Voltando: **${prev.title}**`);
      } else {
        await interaction.reply({ content: '❌ Sem histórico.', ephemeral: true });
      }
      break;
    }

    case 'stop': {
      stop(guildId);
      await interaction.reply('⏹️ Música parada e fila limpa.');
      break;
    }

    case 'pause': {
      const ok = pause(guildId);
      await interaction.reply(ok ? '⏸️ Pausado.' : '❌ Nada tocando.');
      break;
    }

    case 'resume': {
      const ok = resume(guildId);
      await interaction.reply(ok ? '▶️ Retomado.' : '❌ Nada pausado.');
      break;
    }

    case 'loop': {
      const looping = toggleLoop(guildId);
      await interaction.reply(looping ? '🔁 Loop **ativado**.' : '➡️ Loop **desativado**.');
      break;
    }

    case 'queue': {
      const q = getQueue(guildId);
      const lines: string[] = [];

      if (q.current) {
        lines.push(`🎵 **Tocando:** ${q.current.title} [${q.current.duration}]`);
      }

      if (q.tracks.length > 0) {
        lines.push('');
        lines.push('**Fila:**');
        q.tracks.slice(0, 10).forEach((t, i) => {
          lines.push(`${i + 1}. ${t.title} [${t.duration}] — *${t.requestedBy}*`);
        });
        if (q.tracks.length > 10) {
          lines.push(`... e mais ${q.tracks.length - 10} músicas`);
        }
      }

      if (lines.length === 0) {
        await interaction.reply('📭 Fila vazia.');
        return;
      }

      if (q.loop) lines.push('\n🔁 Loop ativado');

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎶 Fila de Música')
        .setDescription(lines.join('\n'))
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      break;
    }

    case 'np': {
      const current = nowPlaying(guildId);
      if (!current) {
        await interaction.reply('🔇 Nada tocando.');
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('🎵 Tocando agora')
        .setDescription(`**[${current.title}](${current.url})**`)
        .addFields(
          { name: 'Duração', value: current.duration, inline: true },
          { name: 'Pedido por', value: current.requestedBy, inline: true }
        );

      if (current.thumbnail) embed.setThumbnail(current.thumbnail);

      await interaction.reply({ embeds: [embed] });
      break;
    }
  }
}
