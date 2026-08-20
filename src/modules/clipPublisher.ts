import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import fs from 'fs';
import { OpusPacket } from './replayBuffer';
import { getSettings, ClipFormat } from './guildSettings';
import { storeClip, getClip, attachVideo, PendingClip } from './clipStore';
import { limits, upsell } from './licensing';
import { track } from './telemetry';
import { exportClip, exportWaveform, maxUploadBytes, maxClipSeconds } from '../utils/audioExporter';
import {
  exportRoomVideo,
  speakingTimeline,
  renderBusy,
  MAX_VIDEO_SECONDS,
  Participant,
} from '../utils/videoExporter';
import { logger } from '../utils/logger';

const CLIP_COLOR = 0xff4d4d;

export function formatLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${min} min` : `${min} min ${rest}s`;
}

// Teto de duração pelo limite de anexo do servidor: pedir 15 min num servidor
// sem boost gera um arquivo que o Discord recusa, e o usuário só via o erro
// depois de esperar a exportação.
export function clipSecondsCap(interaction: ChatInputCommandInteraction): number {
  const tier = interaction.guild?.premiumTier ?? 0;
  return maxClipSeconds(maxUploadBytes(Number(tier)));
}

function participantsField(guild: Guild | null, userIds: string[]): string {
  const names = userIds.map((id) => {
    const member = guild?.members.cache.get(id);
    return member ? member.displayName : `<@${id}>`;
  });
  if (names.length === 0) return '—';
  if (names.length <= 8) return names.join(', ');
  return `${names.slice(0, 8).join(', ')} +${names.length - 8}`;
}

// Sem checar permissão o send estoura, a resposta deferida nunca é resolvida e o
// admin fica olhando "pensando..." sem saber que o canal que ele escolheu é
// fechado pro bot.
function resolveClipsChannel(guild: Guild | null): TextChannel | null {
  if (!guild) return null;
  const clipsChannelId = getSettings(guild.id).clipsChannelId;
  if (!clipsChannelId) return null;
  const channel = guild.channels.cache.get(clipsChannelId);
  if (!channel?.isTextBased()) return null;
  const me = guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (
    !perms?.has(PermissionFlagsBits.ViewChannel) ||
    !perms.has(PermissionFlagsBits.SendMessages) ||
    !perms.has(PermissionFlagsBits.AttachFiles) ||
    !perms.has(PermissionFlagsBits.EmbedLinks)
  ) {
    logger.warn(`[CLIP] ${guild.id}: sem permissão no canal de clips ${clipsChannelId}`);
    return null;
  }
  return channel as TextChannel;
}

// O avatar e o apelido só existem no cliente do Discord. Buscar o membro é o que
// transforma um id de usuário em alguém reconhecível dentro do vídeo.
async function resolveParticipants(guild: Guild | null, userIds: string[]): Promise<Participant[]> {
  const out: Participant[] = [];
  for (const userId of userIds) {
    try {
      const member = await guild?.members.fetch(userId);
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

// Só o formato que ainda não veio anexado vira botão: com os dois sempre na tela
// e um deles desabilitado, o clip parecia estar esperando um clique pra sair.
function formatRow(
  clipId: string,
  current: ClipFormat,
  allowVideo: boolean
): ActionRowBuilder<ButtonBuilder>[] {
  if (current === 'mp3' && !allowVideo) return [];
  const button =
    current === 'mp3'
      ? new ButtonBuilder()
          .setCustomId(`clip:video:${clipId}`)
          .setLabel('Também em vídeo da sala')
          .setEmoji('🎬')
      : new ButtonBuilder().setCustomId(`clip:mp3:${clipId}`).setLabel('Também em MP3').setEmoji('🎧');
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(button.setStyle(ButtonStyle.Secondary)),
  ];
}

function clipEmbed(clip: PendingClip, guild: Guild | null, sizeBytes: number): EmbedBuilder {
  const voiceChannel = clip.channelName ?? guild?.members.me?.voice.channel?.name ?? null;
  return new EmbedBuilder()
    .setColor(CLIP_COLOR)
    .setAuthor({ name: clip.authorName, iconURL: clip.authorIcon })
    .setTitle(clip.kind === 'clip' ? `🎬 Clip • últimos ${clip.label}` : `⏺️ Replay • ${clip.label}`)
    .addFields(
      { name: 'Na call', value: participantsField(guild, clip.userIds), inline: false },
      { name: 'Canal', value: voiceChannel ? `🔊 ${voiceChannel}` : '—', inline: true },
      { name: 'Duração', value: clip.label, inline: true },
      { name: 'Tamanho', value: `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`, inline: true }
    )
    .setFooter({ text: 'Valdez • /clip' })
    .setTimestamp();
}

interface PublishOptions {
  packets: Map<string, OpusPacket[]>;
  seconds: number;
  kind: 'clip' | 'replay';
  // Vem junto da entrega em vez de virar uma edição própria: o aviso anterior era
  // sobrescrito pelo resultado antes de qualquer um conseguir ler.
  notice?: string;
}

// O tempo pedido não é o tempo que existe: /clip 15min logo depois do bot entrar
// na call produz 20s de áudio. Anunciar o pedido virava um clip rotulado "15 min"
// com 20 segundos dentro — e ainda escolhia bitrate e limite de vídeo pelo número
// errado.
function realSeconds(packets: Map<string, OpusPacket[]>, requested: number): number {
  let first = Infinity;
  let last = 0;
  for (const list of packets.values()) {
    for (const p of list) {
      if (p.timestamp < first) first = p.timestamp;
      if (p.timestamp > last) last = p.timestamp;
    }
  }
  if (!Number.isFinite(first) || last <= first) return requested;
  return Math.min(requested, Math.max(1, Math.round((last - first) / 1000)));
}

// O mp3 sai sempre; o vídeo só toma o lugar dele quando o servidor pediu isso e
// o clip cabe no render. Qualquer tropeço aqui devolve o mp3 que já está pronto,
// com o motivo junto — sumir em silêncio seria pior que não ter vídeo.
async function preferredVideo(
  interaction: ChatInputCommandInteraction,
  clip: PendingClip,
  limit: number
): Promise<{ path: string | null; notice?: string }> {
  const guildId = clip.guildId;
  if (getSettings(guildId).clipFormat !== 'video') return { path: null };
  if (!limits(guildId).roomVideo) {
    return { path: null, notice: '⚠️ Vídeo da sala é do plano Max — mandei o MP3. Veja `/assinatura`.' };
  }
  if (clip.seconds > MAX_VIDEO_SECONDS) {
    return {
      path: null,
      notice: `⚠️ A sala em vídeo vai até ${MAX_VIDEO_SECONDS / 60} min e esse clip tem ${clip.label} — mandei o MP3.`,
    };
  }
  if (renderBusy()) {
    return { path: null, notice: '⚠️ Já tinha um vídeo renderizando — mandei o MP3.' };
  }

  try {
    const participants = await resolveParticipants(interaction.guild, clip.userIds);
    const videoPath = await exportRoomVideo(
      clip.timeline,
      participants,
      clip.audioPath,
      `${clip.kind}_${guildId}_${clip.id}`,
      `${clip.kind} • ${clip.label}`
    );
    if (fs.statSync(videoPath).size > limit) {
      try {
        fs.unlinkSync(videoPath);
      } catch {
        /* já removido */
      }
      return { path: null, notice: '⚠️ O vídeo passou do limite de anexo do servidor — mandei o MP3.' };
    }
    attachVideo(clip.id, videoPath);
    track(guildId, 'clip', { userId: interaction.user.id, seconds: clip.seconds, detail: 'video' });
    return { path: videoPath };
  } catch (err: any) {
    logger.error(`[CLIP] ${guildId}: vídeo padrão falhou: ${err?.message}`);
    return { path: null, notice: '⚠️ Não consegui montar a sala em vídeo — mandei o MP3.' };
  }
}

export async function publishClip(
  interaction: ChatInputCommandInteraction,
  { packets, seconds: requested, kind, notice }: PublishOptions
): Promise<void> {
  const seconds = realSeconds(packets, requested);
  const label = formatLabel(seconds);
  const filename = `${kind}_${interaction.guildId}_${Date.now()}`;
  const limit = maxUploadBytes(Number(interaction.guild?.premiumTier ?? 0));

  let audioPath: string;
  try {
    audioPath = await exportClip(packets, filename, seconds, limit);
  } catch (err: any) {
    logger.error(`[CLIP] ${interaction.guildId}: export falhou: ${err?.message}`);
    await interaction.editReply('❌ Não consegui exportar o áudio. Tenta de novo em alguns segundos.');
    return;
  }

  const audioSize = fs.statSync(audioPath).size;
  if (audioSize > limit) {
    const capMin = Math.floor(clipSecondsCap(interaction) / 60);
    await interaction.editReply(
      `❌ O clip ficou com ${(audioSize / 1024 / 1024).toFixed(1)} MB e este servidor aceita até ` +
        `${Math.round(limit / 1024 / 1024)} MB. Peça no máximo **${capMin} min**.`
    );
    try {
      fs.unlinkSync(audioPath);
    } catch {
      /* já removido */
    }
    return;
  }

  // A timeline sai dos mesmos timestamps que o mixer usou, então guardá-la agora
  // é o que permite montar o vídeo depois sem segurar os pacotes na memória.
  const clip = storeClip({
    guildId: interaction.guildId!,
    kind,
    seconds,
    label,
    audioPath,
    timeline: speakingTimeline(packets),
    userIds: [...packets.keys()],
    channelName: interaction.guild?.members.me?.voice.channel?.name ?? null,
    authorId: interaction.user.id,
    authorName: interaction.user.displayName,
    authorIcon: interaction.user.displayAvatarURL(),
  });

  const video = await preferredVideo(interaction, clip, limit);
  const current: ClipFormat = video.path ? 'video' : 'mp3';
  const mainPath = video.path ?? audioPath;
  const mainSize = video.path ? fs.statSync(video.path).size : audioSize;
  const avisos = [notice, video.notice].filter(Boolean).join('\n');

  const files = [
    new AttachmentBuilder(mainPath, {
      name: `${kind}-${label.replace(/\s/g, '')}.${video.path ? 'mp4' : 'mp3'}`,
    }),
  ];
  // A onda é o preview do mp3; com o vídeo anexado ela só rouba o embed.
  const wavePath = video.path ? null : await exportWaveform(audioPath);
  if (wavePath) files.push(new AttachmentBuilder(wavePath, { name: 'waveform.png' }));

  const embed = clipEmbed(clip, interaction.guild, mainSize);
  if (wavePath) embed.setImage('attachment://waveform.png');
  const components = formatRow(clip.id, current, limits(clip.guildId).roomVideo);

  try {
    const clipsChannel = resolveClipsChannel(interaction.guild);
    if (clipsChannel && clipsChannel.id !== interaction.channelId) {
      const posted = await clipsChannel.send({ embeds: [embed], files, components });
      await interaction.editReply(
        `✅ Clip de ${label} postado em <#${clipsChannel.id}> — ${posted.url}${avisos ? `\n${avisos}` : ''}`
      );
    } else {
      await interaction.editReply({ content: avisos, embeds: [embed], files, components });
    }
  } catch (err: any) {
    logger.error(`[CLIP] ${interaction.guildId}: envio falhou: ${err?.message}`);
    await interaction
      .editReply('❌ Não consegui postar o clip. Confira se eu posso enviar mensagens e anexos no canal.')
      .catch(() => {});
  } finally {
    if (wavePath) {
      setTimeout(() => {
        try {
          fs.unlinkSync(wavePath);
        } catch {
          /* já removido */
        }
      }, 30_000);
    }
  }
}

async function replyGone(interaction: ButtonInteraction): Promise<void> {
  await interaction.reply({
    content: '⌛ Esse clip expirou. Roda `/clip` de novo para gerar outro.',
    ephemeral: true,
  });
}

async function sendAudio(interaction: ButtonInteraction, clip: PendingClip): Promise<void> {
  if (!fs.existsSync(clip.audioPath)) {
    await replyGone(interaction);
    return;
  }
  // O upload é a resposta inicial, e o Discord fecha a interação em 3s: qualquer
  // mp3 que demore mais que isso pra subir virava "interação falhou" e nada mais.
  await interaction.deferReply();
  const size = fs.statSync(clip.audioPath).size;
  const embed = clipEmbed(clip, interaction.guild, size);
  await interaction.editReply({
    embeds: [embed],
    files: [
      new AttachmentBuilder(clip.audioPath, {
        name: `${clip.kind}-${clip.label.replace(/\s/g, '')}.mp3`,
      }),
    ],
    components: formatRow(clip.id, 'mp3', limits(clip.guildId).roomVideo),
  });
}

async function sendVideo(interaction: ButtonInteraction, clip: PendingClip): Promise<void> {
  const limit = maxUploadBytes(Number(interaction.guild?.premiumTier ?? 0));

  if (clip.videoPath && fs.existsSync(clip.videoPath)) {
    await interaction.deferReply();
    const size = fs.statSync(clip.videoPath).size;
    await interaction.editReply({
      embeds: [clipEmbed(clip, interaction.guild, size)],
      files: [
        new AttachmentBuilder(clip.videoPath, {
          name: `${clip.kind}-${clip.label.replace(/\s/g, '')}.mp4`,
        }),
      ],
      components: formatRow(clip.id, 'video', true),
    });
    return;
  }

  if (!fs.existsSync(clip.audioPath)) {
    await replyGone(interaction);
    return;
  }

  if (clip.seconds > MAX_VIDEO_SECONDS) {
    await interaction.reply({
      content: `⚠️ A sala em vídeo vai até ${MAX_VIDEO_SECONDS / 60} min — esse clip tem ${clip.label}.`,
      ephemeral: true,
    });
    return;
  }

  // Um render por vez: a VPS divide CPU com as calls ao vivo e duas exportações
  // simultâneas engasgam o áudio de quem está falando.
  if (renderBusy()) {
    await interaction.reply({
      content: '⏳ Já tem um vídeo renderizando. Tenta de novo em alguns segundos.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    // Entre a checagem acima e aqui outro clique pode ter pegado a vez: sem isso
    // o segundo usuário via "não consegui montar o vídeo" e achava que quebrou.
    if (renderBusy()) {
      await interaction.editReply('⏳ Já tem um vídeo renderizando. Tenta de novo em alguns segundos.');
      return;
    }
    const participants = await resolveParticipants(interaction.guild, clip.userIds);
    const videoPath = await exportRoomVideo(
      clip.timeline,
      participants,
      clip.audioPath,
      `${clip.kind}_${clip.guildId}_${clip.id}`,
      `${clip.kind} • ${clip.label}`
    );

    const size = fs.statSync(videoPath).size;
    if (size > limit) {
      try {
        fs.unlinkSync(videoPath);
      } catch {
        /* já removido */
      }
      await interaction.editReply(
        `⚠️ O vídeo ficou com ${(size / 1024 / 1024).toFixed(1)} MB e este servidor aceita até ` +
          `${Math.round(limit / 1024 / 1024)} MB. Tenta um clip mais curto.`
      );
      return;
    }

    attachVideo(clip.id, videoPath);
    track(clip.guildId, 'clip', { userId: interaction.user.id, seconds: clip.seconds, detail: 'video' });

    await interaction.editReply({
      embeds: [clipEmbed(clip, interaction.guild, size)],
      files: [
        new AttachmentBuilder(videoPath, {
          name: `${clip.kind}-${clip.label.replace(/\s/g, '')}.mp4`,
        }),
      ],
      components: formatRow(clip.id, 'video', true),
    });
  } catch (err: any) {
    logger.error(`[CLIP] ${clip.guildId}: vídeo falhou: ${err?.message}`);
    await interaction.editReply('❌ Não consegui montar a sala em vídeo. Tenta de novo em alguns segundos.');
  }
}

export async function handleClipButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, id] = interaction.customId.split(':');
  const clip = getClip(id);
  if (!clip || clip.guildId !== interaction.guildId) {
    await replyGone(interaction);
    return;
  }

  if (action === 'video') {
    if (!limits(clip.guildId).roomVideo) {
      await interaction.reply({ content: upsell('Vídeo da sala', 'max'), ephemeral: true });
      return;
    }
    await sendVideo(interaction, clip);
    return;
  }

  await sendAudio(interaction, clip);
}
