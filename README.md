# AgentDock v1

AgentDock is a local-first browser dashboard for persistent shell and coding-agent sessions. It runs inside WSL/Linux, keeps sessions alive in tmux, reconnects the browser automatically, and can launch one-time or interval automations.

## v1 capabilities

- Shell, Claude Code, and custom-command sessions
- Browser terminal input, resize, reconnect, restart, stop, and delete
- tmux-backed survival across browser disconnects and AgentDock restarts
- Password login with signed, expiring, restart-stable cookies and login throttling
- One-time and interval automations with overlap prevention, pause/enable, run status, and manual runs
- Atomic JSON persistence with backup recovery and graceful shutdown draining
- Windows path conversion when hosted in WSL (`C:\\Users\\...` becomes `/mnt/c/Users/...`)
- Loopback-only defaults, origin checks, CSP, and defensive response headers

## Recommended WSL installation

Requirements inside WSL: Node.js 22+, npm, tmux, and systemd user services. From PowerShell in this repository:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'cd /mnt/c/Users/Admin/Code/agentskai && bash scripts/install-wsl.sh'
```

The installer builds an isolated Linux release under `~/.local/share/agentdock`, writes private configuration to `~/.config/agentdock/agentdock.env`, and enables `agentdock.service`. Open <http://127.0.0.1:3000>.

Useful service commands:

```bash
systemctl --user status agentdock
journalctl --user -u agentdock -f
systemctl --user restart agentdock
```

To change the password or default project directory, edit `~/.config/agentdock/agentdock.env`, then restart the service. A good WSL project default is `/mnt/c/Users/Admin/Code`.

## Development

On the host platform:

```bash
npm install
npm run typecheck
npm test
npm run build
```

Run directly with `npm run dev`, or build and use `npm start`. tmux persistence is available only when the server itself runs in Linux, macOS, or WSL with tmux installed. The server binds to `127.0.0.1` by default and refuses a non-loopback bind unless `AGENTDOCK_PASSWORD` is set.

Configuration is documented in `.env.example`. State defaults to `./data` for direct runs and `~/.local/state/agentdock` for the WSL installer.

## Operational notes

- Stopping or deleting a session intentionally terminates its tmux session.
- Restarting AgentDock detaches from tmux and restores the same session without rerunning the command.
- If a tmux session disappeared while AgentDock was offline, recovery reports an error; it does not silently rerun the old command.
- Automations do not start a second run while their previous session is active.
- AgentDock v1 is designed for one trusted local operator, not public internet exposure or multi-user tenancy.
