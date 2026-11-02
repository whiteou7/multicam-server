# Deploy notes

- `Caddyfile.example`: site blocks for the host Caddy (TLS + reverse proxy).
- `backup-sqlite.sh`: consistent SQLite copy via the running container, keeps the last 7 in `/var/backups/multicam`. Copy that directory off the VM yourself (or sync it to object storage) for real protection.

## Firewall (cloud security group and host firewall)

| Port | Proto | Purpose |
|------|-------|---------|
| 80, 443 | tcp | Caddy (ACME + HTTPS for api. and s3.) |
| 40100-40199 | udp + tcp | mediasoup WebRTC media (bypasses Caddy) |

Do not open 3000, 9000, 9001: compose binds them to 127.0.0.1 only.
`MEDIASOUP_ANNOUNCED_IP` must be the VM public IP.
