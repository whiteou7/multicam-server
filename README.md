# multicam-server

Fastify 4 + TypeScript backend for Horus: auth, rooms, mediasoup WebRTC signaling, video storage (phones upload their own recordings) in MinIO, SQLite.

## Deploy (single VM, Docker + host Caddy)

Prereqs: Docker with the compose plugin, Caddy installed on the host, DNS `api.<domain>` and `s3.<domain>` pointing at the VM.

```bash
git clone https://github.com/whiteou7/multicam-server && cd multicam-server
cp .env.example .env && nano .env      # set MEDIASOUP_ANNOUNCED_IP (VM public IP), MINIO_PUBLIC_ENDPOINT, CORS_ORIGINS
docker compose up -d --build           # or: docker compose pull && docker compose up -d
sudo nano /etc/caddy/Caddyfile         # paste blocks from deploy/Caddyfile.example, then: sudo systemctl reload caddy
curl https://api.<domain>/health       # smoke test
```

The compose image name is `ghcr.io/whiteou7/multicam-server`; change the owner in `docker-compose.yml` if you fork. Open firewall ports as in [deploy/README.md](deploy/README.md).

### Update

```bash
git pull && docker compose up -d --build                     # builds on the VM; no registry push yet
```

Pin a version with `TAG=<git sha>` in `.env`.

### Backup

`deploy/backup-sqlite.sh` (cron example inside the script) keeps the last 7 SQLite copies. MinIO data lives in the `minio-data` volume and is not backed up by the script.

## Environment

Set in `.env` (read by compose). Full list with comments: `.env.example`.

| Variable | Default | Notes |
|----------|---------|-------|
| `MEDIASOUP_ANNOUNCED_IP` | none | Required. VM public IP |
| `MINIO_PUBLIC_ENDPOINT` | empty | Public S3 host for presigned URLs, e.g. `s3.example.com` |
| `MINIO_PUBLIC_PORT` | 443 / 80 | Optional, port of the public S3 host |
| `MINIO_PUBLIC_USE_SSL` | `true` | Scheme of the public S3 host |
| `CORS_ORIGINS` | empty | Comma-separated allowed origins; empty = allow any |
| `JWT_SECRET` | `dev-secret-change-me` | See known gaps |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | `minioadmin` | See known gaps |
| `MINIO_BUCKET` | `multicam-videos` | |
| `MEDIASOUP_RTC_MIN_PORT` / `MAX_PORT` | `40100` / `40199` | Published on the host, udp + tcp |
| `TAG` | `latest` | Image tag |

## Ports

| Port | Bound to | Purpose |
|------|----------|---------|
| 3000 | 127.0.0.1 | API + dashboard (Caddy `api.<domain>`) |
| 9000 | 127.0.0.1 | MinIO S3 (Caddy `s3.<domain>`). Clients PUT uploads directly here via presigned URL, so the s3 Caddy block must allow an unlimited request body |
| 9001 | 127.0.0.1 | MinIO console (SSH tunnel only) |
| 80, 443 | host (Caddy) | HTTPS |
| 40100-40199 | all, udp + tcp | WebRTC media, not proxied |

## Local dev

```bash
cp .env.example .env && npm ci && npm run dev    # needs MinIO on localhost:9000
npm run typecheck
```

## Known gaps

- Default JWT secret, MinIO credentials and the seeded accounts (plain passwords, recreated on every start) are insecure. Override via `.env`; do not hold real user data until fixed.
- No rate limiting.
- Single instance only (SQLite file + in-memory mediasoup state).
- No TURN server: clients on networks blocking both UDP and TCP to 40100-40199 cannot connect.
- Server transcodes every camera with x264; size the VM accordingly (2 vCPU / 4 GB minimum).
