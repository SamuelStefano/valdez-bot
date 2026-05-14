import { OpusPacket } from '../modules/replayBuffer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';
import { Readable } from 'stream';

const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

/**
 * Export Opus packets to an OGG file.
 * Opus packets are already decoded by @discordjs/voice (DAVE handles decryption).
 * We pipe them through ffmpeg as raw opus frames.
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
  allPackets.sort((a, b) => a.timestamp - b.timestamp);

  if (allPackets.length === 0) {
    throw new Error('No audio data to export');
  }

  logger.info(`Exporting ${allPackets.length} packets to ${outputPath}`);

  // Create a readable stream from opus packets
  // Discord sends 48kHz stereo opus at 20ms frames
  // We'll use ffmpeg to decode opus and re-encode to ogg/opus
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 'opus',        // Input is raw opus
      '-ar', '48000',       // 48kHz sample rate
      '-ac', '2',           // Stereo
      '-i', 'pipe:0',       // Read from stdin
      '-c:a', 'libopus',    // Output codec
      '-b:a', '96k',        // Bitrate
      outputPath,
    ]);

    let stderrLog = '';

    ffmpeg.stderr.on('data', (data) => {
      stderrLog += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        const size = fs.statSync(outputPath).size;
        logger.info(`Exported audio: ${outputPath} (${size} bytes)`);
        resolve(outputPath);
      } else {
        logger.error(`ffmpeg failed (code ${code}): ${stderrLog.slice(-500)}`);
        // Fallback: save raw packets
        exportRawFallback(allPackets, filename).then(resolve).catch(reject);
      }
    });

    ffmpeg.on('error', (err) => {
      logger.error(`ffmpeg error: ${err.message}`);
      exportRawFallback(allPackets, filename).then(resolve).catch(reject);
    });

    // Write all opus packets to ffmpeg stdin
    for (const packet of allPackets) {
      ffmpeg.stdin.write(packet.data);
    }
    ffmpeg.stdin.end();
  });
}

/**
 * Fallback: concatenate raw opus data with OGG container manually
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
 * Export raw opus packets as PCM via ffmpeg, then to mp3
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

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 'opus',
      '-ar', '48000',
      '-ac', '2',
      '-i', 'pipe:0',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      outputPath,
    ]);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on('error', reject);

    for (const packet of allPackets) {
      ffmpeg.stdin.write(packet.data);
    }
    ffmpeg.stdin.end();
  });
}
