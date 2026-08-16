// Preview local do vídeo da sala: gera fala sintética, renderiza e imprime o
// custo. Serve pra ajustar layout sem precisar entrar numa call de verdade.
// Uso: npx ts-node scripts/previewRoom.ts [pessoas] [segundos]
import { exportRoomVideo, speakingTimeline, Participant } from '../src/utils/videoExporter';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const people = Number(process.argv[2] ?? 3);
const seconds = Number(process.argv[3] ?? 20);

const OUT = path.join(process.cwd(), 'recordings');
fs.mkdirSync(OUT, { recursive: true });

const audio = path.join(OUT, 'preview.mp3');
spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '64k', audio]);

const base = Date.now();
const packets = new Map<string, { data: Buffer; timestamp: number }[]>();
const participants: Participant[] = [];

for (let u = 0; u < people; u++) {
  const list: { data: Buffer; timestamp: number }[] = [];
  // Turnos alternados: cada um fala ~2s e passa a vez, com sobreposição ocasional.
  for (let t = u * 2200; t < seconds * 1000; t += people * 2200) {
    for (let f = 0; f < 100; f++) list.push({ data: Buffer.alloc(0), timestamp: base + t + f * 20 });
  }
  packets.set(`user${u}`, list);
  participants.push({
    userId: `user${u}`,
    name: ['samuel', 'valdez', 'joao', 'maria', 'pedro', 'ana', 'lucas', 'bia', 'rafa'][u] ?? `p${u}`,
    avatarUrl: `https://cdn.discordapp.com/embed/avatars/${u % 6}.png`,
  });
}

console.log('timeline:', [...speakingTimeline(packets)].map(([id, segs]) => `${id}=${segs.length}`).join(' '));

const started = Date.now();
exportRoomVideo(packets, participants, audio, 'preview', `clip de ${seconds}s`)
  .then((out) => {
    const size = fs.statSync(out).size;
    console.log(`ok ${out} ${(size / 1024).toFixed(0)}KB em ${((Date.now() - started) / 1000).toFixed(1)}s`);
  })
  .catch((err) => {
    console.error('falhou:', err.message);
    process.exit(1);
  });
