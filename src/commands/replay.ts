import { ChatInputCommandInteraction, SlashCommandBuilder, AttachmentBuilder, TextChannel } from 'discord.js';
import { getBufferSnapshot, startRecording, stopRecording, getActiveRecordings } from '../modules/replayBuffer';
import { exportToOgg } from '../utils/audioExporter';
import { config } from '../config';
import fs from 'fs';

export const data = new SlashCommandBuilder()
  .setName('replay')
  .setDescription('Grava os últimos 2 minutos + continua gravando até parar')
  .addSubcommand(sub =>
    sub.setName('start').setDescription('Começa a gravar (salva os últimos 2 min + continua)')
  )
  .addSubcommand(sub =>
    sub.setName('stop').setDescription('Para a gravação e envia o áudio')
  )
  .addSubcommand(sub =>
    sub.setName('clip')
      .setDescription('Salva os últimos N minutos como clip')
      .addIntegerOption(opt =>
        opt.setName('duracao')
          .setDescription('Quanto tempo voltar (default 2min)')
          .addChoices(
            { name: '30 segundos', value: 30 },
            { name: '1 minuto', value: 60 },
            { name: '2 minutos', value: 120 },
            { name: '5 minutos', value: 300 },
            { name: '10 minutos', value: 600 },
            { name: '15 minutos', value: 900 },
          )
      )
  );

async function getClipsChannel(interaction: ChatInputCommandInteraction): Promise<TextChannel | null> {
  if (!config.logChannelId) return null;
  const channel = interaction.client.channels.cache.get(config.logChannelId);
  if (channel && channel.isTextBased()) return channel as TextChannel;
  return null;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    const active = getActiveRecordings();
    if (active.size > 0) {
      await interaction.reply({ content: '⚠️ Já tem uma gravação em andamento. Use `/replay stop` para parar.', ephemeral: true });
      return;
    }

    const sessionId = startRecording(interaction.user.id);
    await interaction.reply(`🔴 **Gravando!** Os últimos 2 minutos foram salvos no buffer.\nUse \`/replay stop\` para parar e receber o áudio.\n\n*Session: ${sessionId}*`);
  }

  if (sub === 'stop') {
    const active = getActiveRecordings();
    if (active.size === 0) {
      await interaction.reply({ content: '⚠️ Nenhuma gravação em andamento.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    const sessionId = active.keys().next().value!;
    const packets = stopRecording(sessionId);

    if (!packets || packets.size === 0) {
      await interaction.editReply('❌ Sem áudio capturado.');
      return;
    }

    try {
      const filename = `replay_${Date.now()}`;
      const filePath = await exportToOgg(packets, filename);
      const attachment = new AttachmentBuilder(filePath, { name: `${filename}.ogg` });

      // Send to clips channel
      const clipsChannel = await getClipsChannel(interaction);
      if (clipsChannel) {
        await clipsChannel.send({
          content: `🔴 **Replay** por **${interaction.user.displayName}**`,
          files: [attachment],
        });
        await interaction.editReply(`✅ **Gravação enviada para <#${config.logChannelId}>!**`);
      } else {
        await interaction.editReply({ content: '✅ **Gravação salva!**', files: [attachment] });
      }

      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 30_000);
    } catch (err: any) {
      await interaction.editReply(`❌ Erro ao exportar áudio: ${err.message}`);
    }
  }

  if (sub === 'clip') {
    await interaction.deferReply();

    const durationSec = interaction.options.getInteger('duracao') ?? config.defaultClipSeconds;
    const label = durationSec < 60 ? `${durationSec}s` : `${Math.round(durationSec / 60)}min`;

    const snapshot = getBufferSnapshot(durationSec);
    if (snapshot.size === 0) {
      await interaction.editReply(`❌ Buffer vazio — ninguém falou nos últimos ${label}.`);
      return;
    }

    try {
      const filename = `clip_${Date.now()}`;
      const filePath = await exportToOgg(snapshot, filename);
      const attachment = new AttachmentBuilder(filePath, { name: `${filename}.ogg` });

      // Send to clips channel
      const clipsChannel = await getClipsChannel(interaction);
      if (clipsChannel) {
        await clipsChannel.send({
          content: `🎬 **Clip ${label}** por **${interaction.user.displayName}**`,
          files: [attachment],
        });
        await interaction.editReply(`🎬 **Clip de ${label} enviado para <#${config.logChannelId}>!**`);
      } else {
        await interaction.editReply({ content: `🎬 **Clip dos últimos ${label}!**`, files: [attachment] });
      }

      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 30_000);
    } catch (err: any) {
      await interaction.editReply(`❌ Erro ao exportar clip: ${err.message}`);
    }
  }
}
