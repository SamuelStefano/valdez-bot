FROM node:22-slim

# fonts-dejavu-core: o node:22-slim vem sem nenhuma fonte, e o drawtext do ffmpeg
# exige um arquivo .ttf. Sem isso o vídeo da sala sai sem os nomes das pessoas.
RUN apt-get update && apt-get install -y \
  ffmpeg \
  fonts-dejavu-core \
  python3 \
  curl \
  ca-certificates \
  build-essential \
  tzdata \
  && curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && yt-dlp --version \
  && rm -rf /var/lib/apt/lists/*

# O yt-dlp resolve o desafio de assinatura do YouTube executando JavaScript e só
# habilita o Deno por padrão. Sem ele a extração cai em "No supported JavaScript
# runtime" e o áudio não sai nem com os cookies válidos.
RUN curl -fsSL -o /tmp/deno.zip \
      https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip \
  && python3 -c "import zipfile; zipfile.ZipFile('/tmp/deno.zip').extractall('/usr/local/bin')" \
  && chmod +x /usr/local/bin/deno \
  && rm /tmp/deno.zip \
  && deno --version

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

CMD ["node", "dist/index.js"]
