# Security

## Trust model

AgentSkai administrators can create host bind mounts, execute commands, manage credentials, and control containers through the Docker daemon. Treat an administrator as a host operator. Members are restricted to their owned workspaces and cannot create direct-host workspaces.

Workspace containers drop Linux capabilities and enable `no-new-privileges`, but containers are not a security boundary against a hostile Docker daemon or host administrator. Never mount the Docker socket into a workspace container.

Credential values are encrypted using AES-256-GCM and are never returned through list/read APIs. The master key is deliberately stored separately from SQLite when file-key mode is used. Anyone with both the database and key can decrypt credentials.

## Production checklist

- Bind AgentSkai to loopback and terminate TLS at a maintained reverse proxy.
- Set `AGENTSKAI_TRUST_PROXY=1` only behind a trusted proxy that overwrites forwarded headers.
- Use unique administrator passwords and limit administrator membership.
- Protect `/var/lib/agentskai`, the master key, environment file, backups, and Docker socket.
- Keep Node.js, Docker, the base workspace image, and the host OS patched.
- Review audit events and test database plus master-key restores regularly.
- Set workspace CPU, memory, PID, and network limits according to tenant risk.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not include live credentials, personal data, or exploit details in a public issue.
