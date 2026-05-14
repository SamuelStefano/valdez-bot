# Valdez Bot 🤖

Discord bot que fica 24/7 na call do seu servidor.

## Features

- **🎧 Sempre em call** — Fica permanentemente no canal de voz
- **⏱️ Tracking de horas** — Contabiliza tempo de cada pessoa em call
- **🎬 Replay Buffer** — Grava os últimos 2 minutos e continua gravando sob demanda
- **🎵 Music Player** — Toca músicas do YouTube e Spotify

## Comandos

| Comando | Descrição |
|---------|-----------|
| `/ping` | Verifica se o bot está online |
| `/horas` | Mostra suas horas em call |
| `/leaderboard` | Ranking de horas em call |
| `/play <música>` | Toca uma música (YouTube URL, Spotify URL ou busca) |
| `/music skip` | Pula a música atual |
| `/music stop` | Para e limpa a fila |
| `/music pause` | Pausa |
| `/music resume` | Retoma |
| `/music loop` | Ativa/desativa loop |
| `/music queue` | Mostra a fila |
| `/music np` | Mostra a música atual |
| `/replay start` | Salva os últimos 2 min + continua gravando |
| `/replay stop` | Para a gravação e envia o áudio |
| `/replay clip` | Salva apenas os últimos 2 minutos |

## Setup

### 1. Criar o Bot no Discord

1. Acesse [Discord Developer Portal](https://discord.com/developers/applications)
2. Clique em **New Application** → nome: `Valdez`
3. Vá em **Bot** → clique em **Add Bot**
4. Copie o **Token**
5. Ative os intents: **Server Members Intent** e **Message Content Intent**
6. Em **OAuth2 > URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Connect`, `Speak`, `Use Voice Activity`, `Send Messages`, `Embed Links`, `Attach Files`
7. Use a URL gerada para adicionar o bot ao servidor

### 2. Pegar os IDs

- Ative **Developer Mode** no Discord (Configurações > Avançado)
- Click direito no servidor → **Copy Server ID** → `GUILD_ID`
- Click direito no canal de voz → **Copy Channel ID** → `VOICE_CHANNEL_ID`
- O **Client ID** está em General Information no Developer Portal

### 3. Configurar variáveis

```bash
cp .env.example .env
# Preencha os valores no .env
```

### 4. Rodar local

```bash
npm install
npm run build
npm start
```

### 5. Deploy no Railway

1. Crie uma conta em [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Adicione as variáveis de ambiente (mesmas do .env)
4. Deploy automático!

## Stack

- TypeScript + Node.js 20
- discord.js 14
- @discordjs/voice + opus
- play-dl (YouTube/Spotify)
- better-sqlite3
- ffmpeg (para exportar áudio)
