import { execFileSync, spawnSync } from 'node:child_process';

export function tmuxAvailable(): boolean {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export function createTmuxSession(name: string, cwd: string, command: string, args: string[]): void {
  const result = spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', cwd, '--', command, ...args], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'Unable to create tmux session');
}

export function configureTmuxSession(name: string): void {
  const commands = [
    ['set-option', '-t', name, 'mouse', 'on'],
    ['set-option', '-t', name, 'status', 'off'],
    ['set-window-option', '-t', name, 'history-limit', '50000'],
  ];
  for (const args of commands) {
    try { execFileSync('tmux', args, { stdio: 'ignore', timeout: 2000 }); } catch { /* Best effort for older tmux versions. */ }
  }
}

function tmuxInvocation(containerName?: string): { command: string; prefix: string[] } {
  return containerName
    ? { command: process.env.AGENTSKAI_DOCKER_BIN ?? 'docker', prefix: ['exec', containerName, 'tmux'] }
    : { command: 'tmux', prefix: [] };
}

export function cancelTmuxCopyMode(name: string, containerName?: string): void {
  const invocation = tmuxInvocation(containerName);
  try {
    execFileSync(invocation.command, [...invocation.prefix, 'send-keys', '-X', '-t', name, 'cancel'], { stdio: 'ignore', timeout: 2000 });
  } catch {
    // The pane was not in copy mode, or the tmux session ended between events.
  }
}

/** Scroll tmux history without injecting terminal mouse escape sequences. */
export function scrollTmuxSession(name: string, lines: number, containerName?: string): boolean {
  const amount = Math.min(50, Math.max(1, Math.abs(Math.trunc(lines))));
  try {
    // Keep state inspection, scroll and final-state reporting inside one
    // process (and one `docker exec` boundary for container workspaces).
    const script = `
target=$1
direction=$2
amount=$3
state=$(tmux display-message -p -t "$target" '#{pane_in_mode} #{history_size}') || exit 1
set -- $state
mode=$1
history=$2
if [ "$direction" = up ]; then
  if [ "$history" -eq 0 ]; then printf '%s' "$mode"; exit 0; fi
  if [ "$mode" -eq 0 ]; then tmux copy-mode -e -t "$target"; fi
  tmux send-keys -X -N "$amount" -t "$target" scroll-up
else
  if [ "$mode" -eq 0 ]; then printf '0'; exit 0; fi
  tmux send-keys -X -N "$amount" -t "$target" scroll-down
fi
tmux display-message -p -t "$target" '#{pane_in_mode}'
`;
    const args = ['sh', '-c', script, 'agentskai-scroll', name, lines < 0 ? 'up' : 'down', String(amount)];
    const output = containerName
      ? execFileSync(process.env.AGENTSKAI_DOCKER_BIN ?? 'docker', ['exec', containerName, ...args], { encoding: 'utf8', timeout: 3000 })
      : execFileSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 3000 });
    return output.trim() === '1';
  } catch {
    return false;
  }
}

export function captureTmuxSession(name: string): string {
  try {
    return execFileSync('tmux', ['capture-pane', '-p', '-S', '-2000', '-t', name], { encoding: 'utf8', timeout: 3000 });
  } catch {
    return '';
  }
}

export function killTmuxSession(name: string): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore', timeout: 3000 });
  } catch {
    // It may already have exited.
  }
}
