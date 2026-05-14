import { OpusPacket } from '../modules/replayBuffer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';

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
  for (const [, userPackets] of packets) {
    allPackets.push(...userPackets);
  }
  allPackets.sort((a, b) => a.timestamp - b.timestamp);

  if (allPackets.length === 0) {
    throw new Error('No audio data to export');
  }

  logger.info(`Exporting ${allPackets.length} packets to ${outputPath}`);

  if (!OpusScript) {
    return exportRawFallback(allPackets, filename);
  }

  // Decode Opus to PCM
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const pcmChunks: Buffer[] = [];

  for (const packet of allPackets) {
    try {
      const pcm = decoder.decode(packet.data);
      pcmChunks.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    } catch {
      // Skip corrupted packets
    }
  }

  decoder.delete();

  if (pcmChunks.length === 0) {
    throw new Error('All packets failed to decode');
  }

  const pcmBuffer = Buffer.concat(pcmChunks);
  logger.info(`Decoded ${pcmChunks.length} packets to ${pcmBuffer.length} bytes PCM`);

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

/**
 * Export to MP3 via ffmpeg (from decoded PCM)
 */
export async function exportToMp3(
  packets: Map<string, OpusPacket[]>,
  filename: string
): Promise<string> {
  const outputPath = path.join(RECORDINGS_DIR, `${filename}.mp3`);

  const allPackets: OpusPacket[] = [];
  for (const [, userPackets] of packets) {
    allPackets.push(...userPackets);
  }
  allPackets.sort((a, b) => a.timestamp - b.timestamp);

  if (allPackets.length === 0) {
    throw new Error('No audio data to export');
  }

  if (!OpusScript) {
    throw new Error('opusscript not available for MP3 export');
  }

  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const pcmChunks: Buffer[] = [];

  for (const packet of allPackets) {
    try {
      const pcm = decoder.decode(packet.data);
      pcmChunks.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    } catch {
      // Skip corrupted packets
    }
  }

  decoder.delete();
  const pcmBuffer = Buffer.concat(pcmChunks);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      reject(new Error('ffmpeg timed out after 30s'));
    }, 30_000);

    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-i', 'pipe:0',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      outputPath,
    ]);

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ffmpeg.stdin.write(pcmBuffer);
    ffmpeg.stdin.end();
  });
}
