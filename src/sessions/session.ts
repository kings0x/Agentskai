import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import type { SessionConfig, SessionSnapshot, SessionStatus } from '../types.js';
import { cancelTmuxCopyMode, captureTmuxSession, configureTmuxSession, createTmuxSession, killTmuxSession, tmuxAvailable, tmuxSessionExists } from './tmux.js';

interface SessionProcess {
  pid: number;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
}

const require = createRequire(import.meta.url);

export interface SessionEvents {
  output: (data: string) => void;
  state: (snapshot: SessionSnapshot) => void;
}

function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') return { command: process.env.ComSpec ?? 'cmd.exe', args: [] };
  return { command: process.env.SHELL ?? '/bin/bash', args: ['-l'] };
}

function hostCommandFor(config: SessionConfig): { command: string; args: string[] } {
  if (config.mode === 'shell') return defaultShell();
  if (config.mode === 'claude') return { command: process.platform === 'win32' ? 'claude.cmd' : 'claude', args: [] };
  return { command: config.command ?? defaultShell().command, args: config.args ?? [] };
}

export function isTerminalMouseInput(input: string): boolean {
  return /\x1b\[(?:<\d+;\d+;\d+[mM]|M[\s\S]{3}|\d+;\d+;\d+M)/.test(input);
}

export function killContainerTmux(containerName: string | undefined, sessionId: string): void {
  if (!containerName) return;
  const innerTmux = `agentskai-${sessionId.replaceAll('-', '').slice(0, 16)}`;
  try { execFileSync(process.env.AGENTSKAI_DOCKER_BIN ?? 'docker', ['exec', containerName, 'tmux', 'kill-session', '-t', innerTmux], { stdio: 'ignore', timeout: 5000 }); } catch { /* Container or session may already be gone. */ }
}

export class Session extends EventEmitter {
  readonly id: string;
  readonly createdAt: string;
  private process: SessionProcess | null = null;
  private status: SessionStatus = 'starting';
  private endedAt: string | null = null;
  private exitCode: number | null = null;
  private outputBuffer = '';
  private backend: 'pty' | 'tmux' = 'pty';
  private readonly tmuxName: string;
  private detaching = false;
  private tmuxMouseInputPending = false;
  private readonly handledInputIds = new Set<string>();

  constructor(readonly config: SessionConfig, options?: { id?: string; createdAt?: string; tmuxName?: string; dockerEnvFile?: string }) {
    super();
    this.id = options?.id ?? randomUUID();
    this.createdAt = options?.createdAt ?? new Date().toISOString();
    this.tmuxName = options?.tmuxName ?? `agentdock-${this.id.replaceAll('-', '').slice(0, 20)}`;
    this.dockerEnvFile = options?.dockerEnvFile;
  }

  private readonly dockerEnvFile?: string;

  start(options: { requireExistingTmux?: boolean } = {}): void {
    const { command, args } = this.commandForRuntime();
    try {
      const useTmux = this.config.persist !== false && tmuxAvailable();
      if (useTmux) {
        if (!tmuxSessionExists(this.tmuxName)) {
          if (options.requireExistingTmux) throw new Error('The persistent tmux session no longer exists');
          createTmuxSession(this.tmuxName, this.config.cwd, command, args);
        }
        configureTmuxSession(this.tmuxName);
        this.backend = 'tmux';
        this.outputBuffer = captureTmuxSession(this.tmuxName).slice(-200_000);
        this.process = this.spawnTmuxAttach();
      } else {
        this.backend = 'pty';
        if (process.platform === 'win32') {
          const pty = require('node-pty') as { spawn: (file: string, args: string[], options: Record<string, unknown>) => SessionProcess };
          this.process = pty.spawn(command, args, this.ptyOptions());
        } else this.process = this.spawnScript(command, args);
      }
      this.setStatus('running');
      this.process.onData((data) => {
        this.outputBuffer = `${this.outputBuffer}${data}`.slice(-200_000);
        this.emit('output', data);
      });
      this.process.onExit(({ exitCode }) => {
        if (this.detaching) return;
        this.exitCode = exitCode;
        this.endedAt = new Date().toISOString();
        this.process = null;
        if (this.status !== 'stopped') this.setStatus(exitCode === 0 ? 'exited' : 'error');
      });
    } catch (error) {
      this.endedAt = new Date().toISOString();
      this.setStatus('error');
      this.emit('output', `\r\n[agentdock] Failed to start session: ${(error as Error).message}\r\n`);
      throw error;
    }
  }

  write(input: string, requestId?: string): boolean {
    if (!this.process || this.status !== 'running') throw new Error('Session is not running');
    if (requestId && this.handledInputIds.has(requestId)) return false;
    if (this.backend === 'tmux') {
      if (isTerminalMouseInput(input)) this.tmuxMouseInputPending = true;
      else if (this.tmuxMouseInputPending) {
        // Wheel gestures put tmux into copy mode. Return to the live pane before
        // forwarding keyboard input so arrows, typing, and paste reach the shell.
        cancelTmuxCopyMode(this.tmuxName);
        this.tmuxMouseInputPending = false;
      }
    }
    this.process.write(input);
    if (requestId) {
      this.handledInputIds.add(requestId);
      if (this.handledInputIds.size > 2_000) this.handledInputIds.delete(this.handledInputIds.values().next().value!);
    }
    return true;
  }

  resize(cols: number, rows: number): void {
    if (!this.process || this.status !== 'running') return;
    this.process.resize(cols, rows);
  }

  terminalOutput(): string {
    return this.outputBuffer;
  }

  stop(): void {
    this.endedAt ??= new Date().toISOString();
    if (!this.process) {
      this.setStatus('stopped');
      killContainerTmux(this.config.containerName, this.id);
      return;
    }
    this.setStatus('stopped');
    this.process.kill();
    this.process = null;
    if (this.backend === 'tmux') killTmuxSession(this.tmuxName);
    killContainerTmux(this.config.containerName, this.id);
  }

  /** Drop only AgentDock's attachment, leaving tmux alive for restart recovery. */
  detach(): void {
    if (this.backend !== 'tmux' || !this.process) return;
    this.detaching = true;
    this.process.kill();
    this.process = null;
  }

  snapshot(): SessionSnapshot {
    return {
      ...this.config,
      args: this.config.args ? [...this.config.args] : undefined,
      id: this.id,
      status: this.status,
      pid: this.process?.pid ?? null,
      createdAt: this.createdAt,
      endedAt: this.endedAt,
      exitCode: this.exitCode,
      backend: this.backend,
      tmuxName: this.backend === 'tmux' || this.config.persist !== false ? this.tmuxName : undefined,
    };
  }

  private ptyOptions(): Record<string, unknown> {
    return {
      name: 'xterm-256color',
      cols: 120,
      rows: 36,
      cwd: this.config.cwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      useConpty: process.platform === 'win32',
    };
  }

  private commandForRuntime(): { command: string; args: string[] } {
    const inner = hostCommandFor(this.config);
    if (!this.config.containerName) return inner;
    const innerTmux = `agentskai-${this.id.replaceAll('-', '').slice(0, 16)}`;
    const args = ['exec', '-it'];
    if (this.dockerEnvFile) args.push('--env-file', this.dockerEnvFile);
    args.push('-w', this.config.cwd, this.config.containerName, 'tmux', 'new-session', '-A', '-s', innerTmux, '-c', this.config.cwd, '--', inner.command, ...inner.args);
    return { command: process.env.AGENTSKAI_DOCKER_BIN ?? 'docker', args };
  }

  private spawnTmuxAttach(): SessionProcess {
    // `script` allocates a real Linux PTY and proxies it over pipes. This avoids
    // requiring a native node-pty build in WSL while retaining tmux semantics.
    const child = spawn('script', ['-qefc', `tmux attach-session -d -t ${this.tmuxName}`, '/dev/null'], { ...this.ptyOptions(), detached: true }) as ChildProcess;
    const process: SessionProcess = {
      pid: child.pid ?? -1,
      onData: (callback) => { child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8'); child.stdout?.on('data', callback); child.stderr?.on('data', callback); },
      onExit: (callback) => child.on('exit', (exitCode) => callback({ exitCode: exitCode ?? 1 })),
      write: (data) => { child.stdin?.write(data); },
      resize: (columns, rows) => { try { require('node:child_process').execFileSync('tmux', ['resize-window', '-t', this.tmuxName, '-x', String(columns), '-y', String(rows)]); } catch { /* best effort */ } },
      kill: () => { child.kill(); },
    };
    return process;
  }

  private spawnScript(command: string, args: string[]): SessionProcess {
    const quote = (value: string) => `'${value.replaceAll("'", `'\"'\"'`)}'`;
    const child = spawn('script', ['-qefc', [command, ...args].map(quote).join(' '), '/dev/null'], { ...this.ptyOptions(), detached: true }) as ChildProcess;
    return {
      pid: child.pid ?? -1,
      onData: (callback) => { child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8'); child.stdout?.on('data', callback); child.stderr?.on('data', callback); },
      onExit: (callback) => child.on('exit', (exitCode) => callback({ exitCode: exitCode ?? 1 })),
      write: (data) => { child.stdin?.write(data); },
      resize: () => { /* util-linux script does not expose a portable resize API. */ },
      kill: () => { child.kill(); },
    };
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.emit('state', this.snapshot());
  }
}
