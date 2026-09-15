import { resolve } from 'node:path';

/** Accept Windows paths pasted into a dashboard whose server is running in WSL. */
export function normalizeWorkingDirectory(input: string): string {
  const value = input.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (process.platform !== 'win32') {
    const drivePath = /^([a-zA-Z]):[\\/](.*)$/.exec(value);
    if (drivePath) {
      const drive = drivePath[1]!.toLowerCase();
      const rest = drivePath[2]!.replaceAll('\\', '/');
      return resolve(`/mnt/${drive}/${rest}`);
    }
    const wslPath = /^\\\\wsl(?:\.localhost)?\\[^\\]+\\(.*)$/i.exec(value);
    if (wslPath) return resolve(`/${wslPath[1]!.replaceAll('\\', '/')}`);
  }
  return resolve(value);
}
