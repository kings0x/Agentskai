# AgentSkai v1

AgentSkai is a self-hosted control plane for persistent coding-agent workspaces. It runs on Linux or WSL, gives each project a durable Docker container, and exposes its tmux-backed shells through a secure browser terminal.

## What v1 includes

- Project/workspace ownership with one persistent container per workspace
- Shell, Claude Code, and custom-command sessions with tmux recovery
- Multi-user local accounts, administrator/member roles, and server-side authorization
- Docker lifecycle controls with CPU, memory, PID, network, capability, and privilege limits
- AES-256-GCM credential encryption; values are never returned by the API
- SQLite/WAL persistence, live backups, documented restore, and JSON-state migration
- Audit events for authentication and resource mutations
- Scheduled and manual automations with overlap protection
- Same-origin checks, login throttling, CSP, defensive headers, secure cookies, HSTS, trusted-proxy support, and optional native TLS
- Dark blue public landing page and responsive operations dashboard
- CI across Node 22/24 and release workflows for GHCR images

## WSL development installation

Docker Desktop must be running with **Settings → Resources → WSL integration → Ubuntu** enabled. The integration on this machine has already been enabled and verified.

From PowerShell in this repository:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'cd /mnt/c/Users/Admin/Code/agentskai && bash scripts/install-wsl.sh'
```

The installer builds `agentskai/workspace:1`, installs an immutable release under `~/.local/share/agentskai`, migrates existing JSON state into SQLite, and restarts the user service. Open <http://127.0.0.1:3000>.

```bash
systemctl --user status agentdock
journalctl --user -u agentdock -f
systemctl --user restart agentdock
```

The initial username is `admin`. Its password is in `~/.config/agentskai/agentdock.env` for a fresh install. Existing installations retain their configured `AGENTDOCK_PASSWORD` as the initial admin password.

When creating a workspace in WSL, use a Linux-visible path such as `/home/akc21/projects/my-app` or `/mnt/c/Users/Admin/Code/my-app`. Windows paths pasted into the API are normalized automatically.

## Production Linux installation

The recommended production layout is:

- AgentSkai bound to loopback (`127.0.0.1:3000`)
- Caddy or Nginx terminating TLS and proxying WebSockets
- a dedicated `agentskai` system user with access to Docker
- application data at `/var/lib/agentskai`
- project roots below `/srv/agentskai/workspaces`

Build and install:

```bash
npm ci
npm run typecheck && npm test && npm run build
docker build -f docker/workspace.Dockerfile -t agentskai/workspace:1 .
sudo install -d -o agentskai -g agentskai /opt/agentskai /var/lib/agentskai /srv/agentskai/workspaces /etc/agentskai
sudo cp -R dist node_modules package.json /opt/agentskai/
sudo cp deploy/agentskai.service /etc/systemd/system/
sudo cp .env.example /etc/agentskai/agentskai.env
sudo chmod 600 /etc/agentskai/agentskai.env
sudo systemctl daemon-reload && sudo systemctl enable --now agentskai
```

Edit the environment file first. Use a unique password of at least 12 characters and generate the master key with `openssl rand -base64 32`. If `AGENTSKAI_MASTER_KEY` is omitted, a mode-0600 key is created at `$AGENTDOCK_DATA_DIR/master.key`; that file must be included in secure backups.

For Compose, copy `.env.example` to `.env`, set `AGENTSKAI_DOMAIN`, the password, and master key, then run `docker compose up -d --build`. Compose mounts `/srv/agentskai/workspaces`; workspace paths must remain under that host directory.

> Docker socket access is effectively root-equivalent on the host. Restrict AgentSkai administrator accounts and the control-plane service accordingly. Workspace containers never receive the Docker socket.

## TLS and reverse proxy

`deploy/Caddyfile` is the production template. Set `AGENTSKAI_TRUST_PROXY=1` so HTTPS forwarded by the trusted proxy produces Secure cookies and HSTS. Do not expose port 3000 publicly.

Native TLS is also supported:

```bash
AGENTSKAI_TLS_CERT=/etc/ssl/agentskai/fullchain.pem
AGENTSKAI_TLS_KEY=/etc/ssl/agentskai/privkey.pem
```

## Backup and restore

The dashboard’s admin page creates consistent SQLite backups without stopping the service. The CLI equivalent requires `sqlite3`:

```bash
sudo AGENTDOCK_DATA_DIR=/var/lib/agentskai scripts/backup.sh
```

Back up both the resulting database and `master.key` (or the externally configured `AGENTSKAI_MASTER_KEY`). Project source directories and container images are separate from the database and need their own backup policy.

Restore intentionally stops the service and verifies the backup first:

```bash
sudo AGENTDOCK_DATA_DIR=/var/lib/agentskai scripts/restore.sh /secure/backups/agentskai-20260915T120000Z.db
```

## Container cleanup

Deleting a workspace removes only its AgentSkai-managed container and keeps project files. To inspect all containers carrying the AgentSkai ownership label:

```bash
scripts/cleanup-containers.sh
scripts/cleanup-containers.sh --apply  # destructive; removes only the listed labeled containers
```

## Development and verification

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

CI repeats these checks on Node 22 and 24 and builds both Docker images. See [SECURITY.md](SECURITY.md) for the trust model and disclosure guidance.
