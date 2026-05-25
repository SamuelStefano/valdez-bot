import { OpusPacket } from '../modules/replayBuffer';
import { config } from '../config';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 20;

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

/**
 * Decode Opus packets to raw PCM, then encode to OGG via ffmpeg.
 * Discord sends 48kHz stereo Opus at 20ms frames (960 samples per channel).
 */
export async function exportToOgg(
  packets: Map<string, OpusPacket[]>,
  filename: string
): Promise<string> {
  const outputPath = path.join(RECORDINGS_DIR, `${filename}.ogg`);

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

  // Pipe raw PCM to ffmpeg → OGG/Opus
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      reject(new Error('ffmpeg timed out after 30s'));
    }, 30_000);

    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 's16le',         // Raw PCM signed 16-bit little-endian
      '-ar', '48000',         // 48kHz sample rate
      '-ac', '2',             // Stereo
      '-i', 'pipe:0',         // Read from stdin
      '-c:a', 'libopus',      // Output codec: Opus
      '-b:a', '96k',          // Bitrate
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

/**
 * Decode every user onto one shared timeline by arrival timestamp and SUM the
 * samples. Gaps stay silent (timing preserved) and simultaneous speakers are
 * mixed — instead of the old behaviour of concatenating all packets in
 * timestamp order, which made overlapping voices ping-pong and dropped silence.
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
  const durationMs = Math.min(maxTs - minTs + FRAME_MS, capMs);
  const totalSamples = Math.ceil((durationMs / 1000) * SAMPLE_RATE) * CHANNELS;

  const mix = new Int32Array(totalSamples);
  const decoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  let decoded = 0;

  for (const userPackets of packets.values()) {
    for (const packet of userPackets) {
      let pcm: Buffer;
      try {
        pcm = decoder.decode(packet.data);
      } catch {
        continue;
      }
      decoded++;
      const n = pcm.length >> 1;
      let offset = Math.round(((packet.timestamp - minTs) / 1000) * SAMPLE_RATE) * CHANNELS;
      for (let i = 0; i < n && offset < totalSamples; i++, offset++) {
        if (offset >= 0) mix[offset] += pcm.readInt16LE(i << 1);
      }
    }
  }
  decoder.delete();

  if (decoded === 0) {
    throw new Error('All packets failed to decode');
  }

  const out = Buffer.allocUnsafe(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const s = mix[i] > 32767 ? 32767 : mix[i] < -32768 ? -32768 : mix[i];
    out.writeInt16LE(s, i * 2);
  }

  logger.info(`Mixed ${decoded} packets from ${packets.size} users → ${(durationMs / 1000).toFixed(1)}s`);
  return out;
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
