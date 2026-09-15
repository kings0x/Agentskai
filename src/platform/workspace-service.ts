import { randomUUID } from 'node:crypto';
import { access, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { DatabaseStore } from '../persistence/database.js';
import type { DockerManager } from '../docker/docker-manager.js';
import { normalizeWorkingDirectory } from '../paths.js';
import type { PublicUser, Workspace, WorkspaceExecution } from '../types.js';

export interface WorkspaceInput {
  name: string;
  hostPath: string;
  execution?: WorkspaceExecution;
  image?: string;
  cpuLimit?: number;
  memoryMb?: number;
  pidsLimit?: number;
  networkMode?: 'bridge' | 'none';
}

export class WorkspaceService {
  constructor(private readonly store: DatabaseStore, private readonly docker: DockerManager) {}

  list(user: PublicUser): Workspace[] { return this.store.listWorkspaces(user.role === 'admin' ? undefined : user.id); }

  getAllowed(id: string, user: PublicUser): Workspace {
    const workspace = this.store.getWorkspace(id);
    if (!workspace || (user.role !== 'admin' && workspace.ownerId !== user.id)) throw new Error('Workspace not found');
    return workspace;
  }

  async create(owner: PublicUser, input: WorkspaceInput): Promise<Workspace> {
    const hostPath = normalizeWorkingDirectory(input.hostPath);
    await mkdir(hostPath, { recursive: true });
    await access(hostPath, constants.R_OK | constants.W_OK);
    if (!(await stat(hostPath)).isDirectory()) throw new Error('Workspace path must be a directory');
    const execution = input.execution ?? 'docker';
    if (execution === 'host' && owner.role !== 'admin') throw new Error('Only administrators can create host workspaces');
    if (execution === 'docker' && !(await this.docker.available())) throw new Error('Docker is unavailable on this server');
    const id = randomUUID();
    const baseSlug = input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';
    const slug = `${baseSlug}-${id.slice(0, 6)}`;
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id, ownerId: owner.id, name: input.name.trim(), slug, hostPath, execution,
      containerName: execution === 'docker' ? `agentskai-ws-${id.replaceAll('-', '').slice(0, 12)}` : null,
      image: input.image ?? process.env.AGENTSKAI_WORKSPACE_IMAGE ?? 'agentskai/workspace:1',
      cpuLimit: input.cpuLimit ?? 2, memoryMb: input.memoryMb ?? 2048, pidsLimit: input.pidsLimit ?? 256,
      networkMode: input.networkMode ?? 'bridge', createdAt: now, updatedAt: now,
    };
    this.store.createWorkspace(workspace);
    try { if (workspace.execution === 'docker') await this.docker.ensure(workspace); }
    catch (error) { this.store.deleteWorkspace(workspace.id); throw error; }
    return workspace;
  }

  async ensure(workspace: Workspace): Promise<void> { if (workspace.execution === 'docker') await this.docker.ensure(workspace); }

  async remove(workspace: Workspace): Promise<void> {
    if (workspace.containerName) await this.docker.remove(workspace.containerName);
    this.store.deleteWorkspace(workspace.id);
  }
}
