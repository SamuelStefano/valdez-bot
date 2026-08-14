import { OpusPacket } from '../modules/replayBuffer';
import { config } from '../config';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 20;

// MP3 mono porque o arquivo é feito pra ser baixado e ouvido fora do Discord —
// Opus/OGG não abre em quase nada no celular. Os bitrates são candidatos: o
// export escolhe o melhor que ainda cabe no limite de anexo do servidor, e é
// isso que mantém clip de 30 min possível sem Nitro.
const MP3_BITRATES_KBPS = [96, 80, 64, 48, 40];
const MIN_BITRATE_KBPS = MP3_BITRATES_KBPS[MP3_BITRATES_KBPS.length - 1];

const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Opus decoder: 48kHz stereo
let OpusScript: any;
try {
  OpusScript = require('opusscript');
} catch {
  logger.warn('opusscript not available — audio export will use raw fallback');
}

// Limite de anexo por servidor. O bot não tem Nitro: o que vale é o boost tier
// do servidor onde ele posta. Boost 1 não aumenta nada.
const UPLOAD_LIMIT_BY_TIER: Record<number, number> = {
  0: 10 * 1024 * 1024,
  1: 10 * 1024 * 1024,
  2: 50 * 1024 * 1024,
  3: 100 * 1024 * 1024,
};

export function maxUploadBytes(premiumTier: number): number {
  return UPLOAD_LIMIT_BY_TIER[premiumTier] ?? UPLOAD_LIMIT_BY_TIER[0];
}

// 5% de folga pro overhead de container e tags.
export function estimatedBytes(seconds: number, kbps: number = MIN_BITRATE_KBPS): number {
  return Math.ceil(((kbps * 1000) / 8) * seconds * 1.05);
}

export function maxClipSeconds(limitBytes: number): number {
  return Math.floor(limitBytes / estimatedBytes(1));
}

function pickBitrate(seconds: number, limitBytes: number): number {
  return (
    MP3_BITRATES_KBPS.find((kbps) => estimatedBytes(seconds, kbps) <= limitBytes) ?? MIN_BITRATE_KBPS
  );
}

/**
 * Decode Opus packets to raw PCM, then re-encode to MP3 via ffmpeg.
 * Discord sends 48kHz stereo Opus at 20ms frames (960 samples per channel).
 */
export async function exportClip(
  packets: Map<string, OpusPacket[]>,
  filename: string,
  seconds: number,
  limitBytes: number
): Promise<string> {
  const outputPath = path.join(RECORDINGS_DIR, `${filename}.mp3`);
  const bitrate = pickBitrate(seconds, limitBytes);

  const allPackets: OpusPacket[] = [];
  for (const userPackets of packets.values()) allPackets.push(...userPackets);

  if (allPackets.length === 0) {
    throw new Error('No audio data to export');
  }

  if (!OpusScript) {
    allPackets.sort((a, b) => a.timestamp - b.timestamp);
    return exportRawFallback(allPackets, filename);
  }

  const pcmBuffer = mixToPcm(packets, allPackets);
  logger.info(`Exporting mixed audio to ${outputPath} (${pcmBuffer.length} bytes PCM)`);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      reject(new Error('ffmpeg timed out after 30s'));
    }, 30_000);

    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 's16le',         // Raw PCM signed 16-bit little-endian
      '-ar', '48000',         // 48kHz sample rate
      '-ac', '2',             // Stereo in (mixer output)
      '-i', 'pipe:0',         // Read from stdin
      '-ac', '1',             // Downmix to mono
      '-c:a', 'libmp3lame',
      '-b:a', `${bitrate}k`,
      outputPath,
    ]);

    let stderrLog = '';

    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderrLog += data.toString();
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && fs.existsSync(outputPath)) {
        const size = fs.statSync(outputPath).size;
        logger.info(`Exported audio: ${outputPath} (${size} bytes)`);
        resolve(outputPath);
      } else {
        logger.error(`ffmpeg failed (code ${code}): ${stderrLog.slice(-500)}`);
        exportRawFallback(allPackets, filename).then(resolve).catch(reject);
      }
    });

    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(`ffmpeg error: ${err.message}`);
      exportRawFallback(allPackets, filename).then(resolve).catch(reject);
    });

    // Write PCM data to ffmpeg stdin
    ffmpeg.stdin.write(pcmBuffer);
    ffmpeg.stdin.end();
  });
}

// Discord delivers one 20ms Opus frame at a time while a user speaks, but the
// arrival timestamp (Date.now()) jitters a few ms each frame. Placing frames by
// raw arrival time leaves micro-gaps/overlaps between consecutive 20ms frames —
// that is the "choppy" sound. So within a speaking run we lay frames strictly
// back-to-back (each is exactly 20ms) and only insert silence when the gap since
// the previous frame is large enough to be a real pause.
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000 * CHANNELS; // 1920
const PAUSE_GAP_MS = 100; // gap above this = real silence, below = same run

/**
 * Mix every user onto one shared timeline: frames are contiguous inside a run,
 * real pauses become silence, and simultaneous speakers are summed.
 */
function mixToPcm(
  packets: Map<string, OpusPacket[]>,
  allPackets: OpusPacket[]
): Buffer {
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const p of allPackets) {
    if (p.timestamp < minTs) minTs = p.timestamp;
    if (p.timestamp > maxTs) maxTs = p.timestamp;
  }

  const capMs = (config.maxRecordingSeconds + 5) * 1000;
  const spanMs = Math.min(maxTs - minTs + FRAME_MS, capMs);
  // +1s headroom: a contiguous run can extend slightly past the wall-clock span.
  const totalSamples = Math.ceil((spanMs / 1000) * SAMPLE_RATE) * CHANNELS + SAMPLE_RATE * CHANNELS;

  const mix = new Int32Array(totalSamples);
  let decoded = 0;

  for (const userPackets of packets.values()) {
    const decoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    let prevTs: number | null = null;
    let writeOffset = 0;

    for (const packet of userPackets) {
      if (prevTs === null) {
        writeOffset = Math.round(((packet.timestamp - minTs) / 1000) * SAMPLE_RATE) * CHANNELS;
      } else if (packet.timestamp - prevTs > PAUSE_GAP_MS) {
        writeOffset += Math.round(((packet.timestamp - prevTs) / 1000) * SAMPLE_RATE) * CHANNELS;
      }
      prevTs = packet.timestamp;

      let pcm: Buffer;
      try {
        pcm = decoder.decode(packet.data);
      } catch {
        writeOffset += FRAME_SAMPLES; // keep timing aligned through a lost frame
        continue;
      }
      decoded++;

      const n = pcm.length >> 1;
      for (let i = 0; i < n && writeOffset + i < totalSamples; i++) {
        const o = writeOffset + i;
        if (o >= 0) mix[o] += pcm.readInt16LE(i << 1);
      }
      writeOffset += n;
    }
    decoder.delete();
  }

  if (decoded === 0) {
    throw new Error('All packets failed to decode');
  }

  let end = totalSamples;
  while (end > 0 && mix[end - 1] === 0) end--; // trim trailing silence headroom

  const out = Buffer.allocUnsafe(end * 2);
  for (let i = 0; i < end; i++) {
    const s = mix[i] > 32767 ? 32767 : mix[i] < -32768 ? -32768 : mix[i];
    out.writeInt16LE(s, i * 2);
  }

  logger.info(`Mixed ${decoded} packets from ${packets.size} users → ${(end / CHANNELS / SAMPLE_RATE).toFixed(1)}s`);
  return out;
}

// Um anexo de áudio sozinho aparece como uma barrinha cinza no feed. A waveform
// é o que faz alguém parar de rolar e clicar no clip.
export async function exportWaveform(audioPath: string): Promise<string | null> {
  if (!audioPath.endsWith('.mp3')) return null;
  const outputPath = audioPath.replace(/\.mp3$/, '.png');

  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', audioPath,
      '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1000x180:colors=#ff4d3d',
      '-frames:v', '1',
      outputPath,
    ]);

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      resolve(null);
    }, 15_000);

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0 && fs.existsSync(outputPath) ? outputPath : null);
    });
    ffmpeg.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

/**
 * Fallback: save raw Opus packet data concatenated
 */
async function exportRawFallback(
  allPackets: OpusPacket[],
  filename: string
): Promise<string> {
  const outputPath = path.join(RECORDINGS_DIR, `${filename}.raw`);
  const rawData = Buffer.concat(allPackets.map(p => p.data));
  fs.writeFileSync(outputPath, rawData);
  logger.info(`Exported raw audio fallback: ${outputPath} (${rawData.length} bytes)`);
  return outputPath;
}
