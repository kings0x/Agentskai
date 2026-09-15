import { build } from 'esbuild';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const outputDir = 'dist/tests';
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const testFiles = (await readdir('test')).filter((file) => file.endsWith('.test.ts'));
const outputFiles = [];

for (const file of testFiles) {
  const outputFile = join(outputDir, file.replace(/\.ts$/, '.mjs'));
  await build({ entryPoints: [join('test', file)], bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: outputFile });
  outputFiles.push(outputFile);
}

const child = spawn(process.execPath, ['--test', ...outputFiles], { stdio: 'inherit', env: { ...process.env, AGENTDOCK_DISABLE_MAIN: '1' } });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
