import { OpusPacket } from '../modules/replayBuffer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';

const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

/**
 * Export Opus packets to an OGG file using ffmpeg.
 * Merges all user streams into a single audio file.
 */
export async function exportToOgg(
  packets: Map<string, OpusPacket[]>,
  filename: string
): Promise<string> {
  const outputPath = path.join(RECORDINGS_DIR, `${filename}.ogg`);

  // Merge all user packets into a single timeline
  const allPackets: OpusPacket[] = [];
  for (const [, userPackets] of packets) {
    allPackets.push(...userPackets);
  }

  // Sort by timestamp
  allPackets.sort((a, b) => a.timestamp - b.timestamp);

  if (allPackets.length === 0) {
    throw new Error('No audio data to export');
  }

  // Write raw opus data and use ffmpeg to convert
  const rawPath = path.join(RECORDINGS_DIR, `${filename}.raw`);

  // Concatenate all opus packet data
  const rawData = Buffer.concat(allPackets.map(p => p.data));
  fs.writeFileSync(rawPath, rawData);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-i', rawPath,
      '-c:a', 'libopus',
      outputPath,
    ]);

    ffmpeg.stderr.on('data', (data) => {
      // ffmpeg outputs to stderr normally
    });

    ffmpeg.on('close', (code) => {
      // Clean up raw file
      try { fs.unlinkSync(rawPath); } catch {}

      if (code === 0) {
        logger.info(`Exported audio to ${outputPath}`);
        resolve(outputPath);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`ffmpeg not found. Install ffmpeg to export audio. ${err.message}`));
    });
  });
}

/**
 * Export raw opus packets as a simple binary file (fallback without ffmpeg).
 */
export async function exportRaw(
  packets: Map<string, OpusPacket[]>,
  filename: string
): Promise<string> {
  const outputPath = path.join(RECORDINGS_DIR, `${filename}.pcm`);

  const allPackets: OpusPacket[] = [];
  for (const [, userPackets] of packets) {
    allPackets.push(...userPackets);
  }
  allPackets.sort((a, b) => a.timestamp - b.timestamp);

  const rawData = Buffer.concat(allPackets.map(p => p.data));
  fs.writeFileSync(outputPath, rawData);

  logger.info(`Exported raw audio to ${outputPath}`);
  return outputPath;
}
