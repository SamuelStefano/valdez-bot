import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  TextChannel,
} from 'discord.js';
import fs from 'fs';
import { OpusPacket } from './replayBuffer';
import { getSettings } from './guildSettings';
import { exportClip, exportWaveform, maxUploadBytes, maxClipSeconds } from '../utils/audioExporter';
import { exportRoomVideo, renderBusy, MAX_VIDEO_SECONDS, Participant } from '../utils/videoExporter';
import { logger } from '../utils/logger';

const CLIP_COLOR = 0xff4d4d;

export function formatLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = seconds / 60;
  return `${Number.isInteger(min) ? min : min.toFixed(1)} min`;
}

// Teto de duração pelo limite de anexo do servidor: pedir 15 min num servidor
// sem boost gera um arquivo que o Discord recusa, e o usuário só via o erro
// depois de esperar a exportação.
export function clipSecondsCap(interaction: ChatInputCommandInteraction): number {
  const tier = interaction.guild?.premiumTier ?? 0;
  return maxClipSeconds(maxUploadBytes(Number(tier)));
}

function participantsField(interaction: ChatInputCommandInteraction, userIds: string[]): string {
  const names = userIds.map((id) => {
    const member = interaction.guild?.members.cache.get(id);
    return member ? member.displayName : `<@${id}>`;
  });
  if (names.length === 0) return '—';
  if (names.length <= 8) return names.join(', ');
  return `${names.slice(0, 8).join(', ')} +${names.length - 8}`;
}

function resolveClipsChannel(interaction: ChatInputCommandInteraction): TextChannel | null {
  const clipsChannelId = getSettings(interaction.guildId!).clipsChannelId;
  if (!clipsChannelId) return null;
  const channel = interaction.guild?.channels.cache.get(clipsChannelId);
  return channel?.isTextBased() ? (channel as TextChannel) : null;
}

export type ClipFormat = 'mp3' | 'video';

interface PublishOptions {
  packets: Map<string, OpusPacket[]>;
  seconds: number;
  kind: 'clip' | 'replay';
  format?: ClipFormat;
}

// O avatar e o apelido só existem no cliente do Discord. Buscar o membro é o que
// transforma um id de usuário em alguém reconhecível dentro do vídeo.
async function resolveParticipants(
  interaction: ChatInputCommandInteraction,
  userIds: string[]
): Promise<Participant[]> {
  const out: Participant[] = [];
  for (const userId of userIds) {
    try {
      const member = await interaction.guild?.members.fetch(userId);
      out.push({
        userId,
        name: member?.displayName ?? 'usuario',
        avatarUrl: member?.displayAvatarURL({ extension: 'png', size: 256 }) ?? null,
      });
    } catch {
      out.push({ userId, name: 'usuario', avatarUrl: null });
    }
  }
  return out;
}

export async function publishClip(
  interaction: ChatInputCommandInteraction,
  { packets, seconds, kind, format = 'mp3' }: PublishOptions
): Promise<void> {
  const label = formatLabel(seconds);
  const filename = `${kind}_${interaction.guildId}_${Date.now()}`;

  const limit = maxUploadBytes(Number(interaction.guild?.premiumTier ?? 0));

  let filePath: string;
  let wavePath: string | null = null;
  let videoPath: string | null = null;
  try {
    filePath = await exportClip(packets, filename, seconds, limit);
  } catch (err: any) {
    logger.error(`[CLIP] ${interaction.guildId}: export falhou: ${err?.message}`);
    await interaction.editReply('❌ Não consegui exportar o áudio. Tenta de novo em alguns segundos.');
    return;
  }

  try {
    const audioSize = fs.statSync(filePath).size;
    if (audioSize > limit) {
      const capMin = Math.floor(clipSecondsCap(interaction) / 60);
      await interaction.editReply(
        `❌ O clip ficou com ${(audioSize / 1024 / 1024).toFixed(1)} MB e este servidor aceita até ` +
          `${Math.round(limit / 1024 / 1024)} MB. Peça no máximo **${capMin} min**.`
      );
      return;
    }

    // O vídeo é um extra: se o render falhar, o clip ainda sai em áudio. Perder o
    // clip inteiro porque a sala não desenhou seria trocar uma coisa boa por nada.
    let videoNote = '';
    if (format === 'video') {
      if (seconds > MAX_VIDEO_SECONDS) {
        videoNote = `\n⚠️ Sala em vídeo vai até ${MAX_VIDEO_SECONDS / 60} min — mandei o áudio.`;
      } else if (renderBusy()) {
        videoNote = '\n⚠️ Já tem um vídeo renderizando agora — mandei o áudio.';
      } else {
        await interaction.editReply('🎞️ Montando a sala... isso leva alguns segundos.');
        try {
          const participants = await resolveParticipants(interaction, [...packets.keys()]);
          videoPath = await exportRoomVideo(packets, participants, filePath, filename, `${kind} • ${label}`);
          if (fs.statSync(videoPath).size > limit) {
            videoPath = null;
            videoNote = '\n⚠️ O vídeo passou do limite de anexo do servidor — mandei o áudio.';
          }
        } catch (err: any) {
          logger.error(`[CLIP] ${interaction.guildId}: vídeo falhou: ${err?.message}`);
          videoPath = null;
          videoNote = '\n⚠️ Não consegui montar a sala em vídeo — mandei o áudio.';
        }
      }
    }

    const files: AttachmentBuilder[] = [];
    const size = videoPath ? fs.statSync(videoPath).size : audioSize;

    if (videoPath) {
      files.push(new AttachmentBuilder(videoPath, { name: `${kind}-${label.replace(/\s/g, '')}.mp4` }));
    } else {
      files.push(new AttachmentBuilder(filePath, { name: `${kind}-${label.replace(/\s/g, '')}.mp3` }));
      wavePath = await exportWaveform(filePath);
      if (wavePath) files.push(new AttachmentBuilder(wavePath, { name: 'waveform.png' }));
    }

    const voiceChannel = interaction.guild?.members.me?.voice.channel?.name;
    const embed = new EmbedBuilder()
      .setColor(CLIP_COLOR)
      .setAuthor({
        name: interaction.user.displayName,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTitle(kind === 'clip' ? `🎬 Clip • últimos ${label}` : `⏺️ Replay • ${label}`)
      .addFields(
        { name: 'Na call', value: participantsField(interaction, [...packets.keys()]), inline: false },
        { name: 'Canal', value: voiceChannel ? `🔊 ${voiceChannel}` : '—', inline: true },
        { name: 'Duração', value: label, inline: true },
        { name: 'Tamanho', value: `${(size / 1024 / 1024).toFixed(1)} MB`, inline: true }
      )
      .setFooter({ text: 'Valdez • /clip' })
      .setTimestamp();

    if (wavePath) embed.setImage('attachment://waveform.png');

    const clipsChannel = resolveClipsChannel(interaction);
    if (clipsChannel && clipsChannel.id !== interaction.channelId) {
      await clipsChannel.send({ embeds: [embed], files });
      await interaction.editReply(`✅ Clip de ${label} postado em <#${clipsChannel.id}>.${videoNote}`);
    } else {
      await interaction.editReply({ content: videoNote.trim(), embeds: [embed], files });
    }
  } finally {
    const temps = [filePath, wavePath, videoPath].filter((p): p is string => p !== null);
    setTimeout(() => {
      for (const p of temps) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* já removido */
        }
      }
    }, 30_000);
  }
}
