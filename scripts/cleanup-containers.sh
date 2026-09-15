#!/usr/bin/env bash
set -euo pipefail
mapfile -t containers < <(docker ps -aq --filter label=io.agentskai.managed=true)
if [[ ${#containers[@]} -eq 0 ]]; then echo 'No AgentSkai-managed containers found.'; exit 0; fi
docker ps -a --filter label=io.agentskai.managed=true --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
if [[ "${1:-}" != '--apply' ]]; then echo 'Dry run only. Pass --apply to remove every listed container.'; exit 0; fi
docker rm -f "${containers[@]}"
