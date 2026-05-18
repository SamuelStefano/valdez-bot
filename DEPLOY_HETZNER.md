# Deploy do Valdez na VPS Hetzner

Guia de migração do Fly.io → VPS pessoal `samuel-agents` (Hetzner CX22).

**Alvo:** `178.156.191.231` (root, ssh-key id_ed25519 da máquina local)

---

## 1. Preparar VPS (uma única vez)

```bash
ssh root@178.156.191.231

# Instala Docker + compose plugin (Ubuntu 24.04)
apt-get update
apt-get install -y ca-certificates curl gnupg ffmpeg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

docker --version
docker compose version

mkdir -p /opt/valdez-bot
```

## 2. Migrar SQLite do Fly.io (preserva horas dos usuários)

Na sua máquina local (com `flyctl` autenticado):

```bash
# Lista volumes do app no Fly
flyctl volumes list -a valdez-discord-bot

# SSH no container Fly e copia o DB pra fora
flyctl ssh sftp -a valdez-discord-bot
> get /app/valdez.db ./valdez-fly-backup.db
> quit

# Envia pra Hetzner
scp ./valdez-fly-backup.db root@178.156.191.231:/opt/valdez-bot/valdez.db.fly
```

Na VPS:

```bash
mkdir -p /opt/valdez-bot/data
mv /opt/valdez-bot/valdez.db.fly /opt/valdez-bot/data/valdez.db
```

> Se o DB do Fly não existir ou estiver vazio, pula esse passo — o bot cria um novo no primeiro boot.

## 3. Clonar repo + .env

```bash
cd /opt/valdez-bot
git clone https://github.com/SamuelStefano/valdez-bot.git .
cp .env.example .env
nano .env
# preenche DISCORD_TOKEN (novo — o antigo vazou em 2026-05-14), GUILD_ID,
# VOICE_CHANNEL_ID, CLIENT_ID, LOG_CHANNEL_ID e SPOTIFY_* se quiser playlist
```

## 4. Build + run

```bash
cd /opt/valdez-bot
docker compose up -d --build
docker compose logs -f
```

Você deve ver:

```
Valdez online como Valdez#XXXX
Spotify token configurado.   (ou warning se não setou)
Slash commands registered
[VOICE] Connected (ready)
```

## 5. Cutover (desligar Fly.io)

Quando o bot na Hetzner estiver online e estável:

```bash
# Na máquina local
flyctl scale count 0 -a valdez-discord-bot
# (depois de uns dias, se tudo OK)
flyctl apps destroy valdez-discord-bot
```

> **Importante:** reseta o `DISCORD_TOKEN` no Discord Developer Portal antes do cutover — o antigo está exposto (ver memória `project_valdez_bot.md`).

---

## Operação

```bash
# Logs em tempo real
docker compose logs -f valdez

# Restart
docker compose restart valdez

# Rebuild após git pull
git pull && docker compose up -d --build

# Backup do DB
cp /opt/valdez-bot/data/valdez.db /opt/valdez-bot/data/valdez.$(date +%F).db
```

### Backup automatizado (cron)

```bash
cat > /opt/valdez-bot/backup.sh <<'EOF'
#!/bin/bash
set -euo pipefail
SRC=/opt/valdez-bot/data/valdez.db
DST=/opt/valdez-bot/data/backups
mkdir -p "$DST"
cp "$SRC" "$DST/valdez.$(date +%F_%H%M).db"
# Mantém só os últimos 14 dias
find "$DST" -name 'valdez.*.db' -mtime +14 -delete
EOF
chmod +x /opt/valdez-bot/backup.sh

(crontab -l 2>/dev/null; echo "0 3 * * * /opt/valdez-bot/backup.sh") | crontab -
```

---

## Troubleshooting

**Bot conecta mas não toca**
```bash
docker compose exec valdez ffmpeg -version
# Deve printar versão do ffmpeg. Se não, rebuild com --no-cache.
```

**SQLite locked / WAL files corrompidos**
```bash
docker compose down
sqlite3 /opt/valdez-bot/data/valdez.db "PRAGMA wal_checkpoint(FULL);"
docker compose up -d
```

**Voice rate limit (DAVE handshake)**
- Sintoma: loop Ready → Signalling → Connecting nos logs
- Solução: deixa a máquina parada por 30+ min, depois `docker compose restart`
