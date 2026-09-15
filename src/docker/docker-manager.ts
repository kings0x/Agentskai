import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Workspace } from '../types.js';

const exec = promisify(execFile);

export interface ContainerStatus { exists: boolean; running: boolean; status: string; }

export class DockerManager {
  constructor(private readonly binary = process.env.AGENTSKAI_DOCKER_BIN ?? 'docker') {}

  async available(): Promise<boolean> {
    try { await exec(this.binary, ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 }); return true; } catch { return false; }
  }

  async status(name: string): Promise<ContainerStatus> {
    try {
      const { stdout } = await exec(this.binary, ['inspect', '--format', '{{.State.Running}}|{{.State.Status}}', name], { timeout: 5000 });
      const [running, status] = stdout.trim().split('|');
      return { exists: true, running: running === 'true', status: status ?? 'unknown' };
    } catch { return { exists: false, running: false, status: 'missing' }; }
  }

  async ensure(workspace: Workspace): Promise<ContainerStatus> {
    if (!workspace.containerName) throw new Error('Workspace has no container name');
    let state = await this.status(workspace.containerName);
    if (!state.exists) {
      await exec(this.binary, [
        'create', '--name', workspace.containerName,
        '--label', 'io.agentskai.managed=true', '--label', `io.agentskai.workspace=${workspace.id}`,
        '--init', '--restart', 'unless-stopped', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--cpus', String(workspace.cpuLimit), '--memory', `${workspace.memoryMb}m`, '--pids-limit', String(workspace.pidsLimit),
        '--network', workspace.networkMode, '--mount', `type=bind,src=${workspace.hostPath},dst=${workspace.hostPath}`,
        '--workdir', workspace.hostPath, workspace.image, 'sleep', 'infinity',
      ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
      state = await this.status(workspace.containerName);
    }
    if (!state.running) {
      await exec(this.binary, ['start', workspace.containerName], { timeout: 30_000 });
      state = await this.status(workspace.containerName);
    }
    return state;
  }

  async stop(name: string): Promise<void> {
    const state = await this.status(name);
    if (state.running) await exec(this.binary, ['stop', '--time', '10', name], { timeout: 20_000 });
  }

  async remove(name: string): Promise<void> {
    const state = await this.status(name);
    if (state.exists) await exec(this.binary, ['rm', '--force', name], { timeout: 30_000 });
  }
}
