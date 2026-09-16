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

export function cancelTmuxCopyMode(name: string): void {
  try {
    execFileSync('tmux', ['send-keys', '-X', '-t', name, 'cancel'], { stdio: 'ignore', timeout: 2000 });
  } catch {
    // The pane was not in copy mode, or the tmux session ended between events.
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
