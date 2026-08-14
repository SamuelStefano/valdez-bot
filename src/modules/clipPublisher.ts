import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  TextChannel,
} from 'discord.js';
import fs from 'fs';
import { OpusPacket } from './replayBuffer';
import { getSettings } from './guildSettings';
import { exportClip, maxUploadBytes, maxClipSeconds } from '../utils/audioExporter';
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

interface PublishOptions {
  packets: Map<string, OpusPacket[]>;
  seconds: number;
  kind: 'clip' | 'replay';
}

export async function publishClip(
  interaction: ChatInputCommandInteraction,
  { packets, seconds, kind }: PublishOptions
): Promise<void> {
  const label = formatLabel(seconds);
  const filename = `${kind}_${interaction.guildId}_${Date.now()}`;

  let filePath: string;
  try {
    filePath = await exportClip(packets, filename);
  } catch (err: any) {
    logger.error(`[CLIP] ${interaction.guildId}: export falhou: ${err?.message}`);
    await interaction.editReply('❌ Não consegui exportar o áudio. Tenta de novo em alguns segundos.');
    return;
  }

  try {
    const size = fs.statSync(filePath).size;
    const limit = maxUploadBytes(Number(interaction.guild?.premiumTier ?? 0));
    if (size > limit) {
      const capMin = Math.floor(clipSecondsCap(interaction) / 60);
      await interaction.editReply(
        `❌ O clip ficou com ${(size / 1024 / 1024).toFixed(1)} MB e este servidor aceita até ` +
          `${Math.round(limit / 1024 / 1024)} MB. Peça no máximo **${capMin} min**.`
      );
      return;
    }

    const attachment = new AttachmentBuilder(filePath, { name: `${kind}-${label.replace(/\s/g, '')}.ogg` });
    const embed = new EmbedBuilder()
      .setColor(CLIP_COLOR)
      .setAuthor({
        name: interaction.user.displayName,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTitle(kind === 'clip' ? `🎬 Clip • últimos ${label}` : `⏺️ Replay • ${label}`)
      .addFields(
        { name: 'Na call', value: participantsField(interaction, [...packets.keys()]), inline: false },
        { name: 'Tamanho', value: `${(size / 1024 / 1024).toFixed(1)} MB`, inline: true }
      )
      .setTimestamp();

    const clipsChannel = resolveClipsChannel(interaction);
    if (clipsChannel && clipsChannel.id !== interaction.channelId) {
      await clipsChannel.send({ embeds: [embed], files: [attachment] });
      await interaction.editReply(`✅ Clip de ${label} postado em <#${clipsChannel.id}>.`);
    } else {
      await interaction.editReply({ content: '', embeds: [embed], files: [attachment] });
    }
  } finally {
    setTimeout(() => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* já removido */
      }
    }, 30_000);
  }
}
