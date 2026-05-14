import { ChatInputCommandInteraction, SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import { getBufferSnapshot, startRecording, stopRecording, getActiveRecordings } from '../modules/replayBuffer';
import { exportToOgg } from '../utils/audioExporter';
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
    sub.setName('clip').setDescription('Salva apenas os últimos 2 minutos como clip')
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    // Check if already recording
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
      await interaction.editReply({ content: '✅ **Gravação salva!**', files: [attachment] });
      // Clean up file after sending
      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 30_000);
    } catch (err: any) {
      await interaction.editReply(`❌ Erro ao exportar áudio: ${err.message}`);
    }
  }

  if (sub === 'clip') {
    await interaction.deferReply();

    const snapshot = getBufferSnapshot();
    if (snapshot.size === 0) {
      await interaction.editReply('❌ Buffer vazio — ninguém falou nos últimos 2 minutos.');
      return;
    }

    try {
      const filename = `clip_${Date.now()}`;
      const filePath = await exportToOgg(snapshot, filename);
      const attachment = new AttachmentBuilder(filePath, { name: `${filename}.ogg` });
      await interaction.editReply({ content: '🎬 **Clip dos últimos 2 minutos!**', files: [attachment] });
      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 30_000);
    } catch (err: any) {
      await interaction.editReply(`❌ Erro ao exportar clip: ${err.message}`);
    }
  }
}
