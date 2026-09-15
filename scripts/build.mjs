import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/public', { recursive: true });

await build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/server.js',
  packages: 'external',
  sourcemap: false,
});

await build({
  entryPoints: ['web/app.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  outfile: 'dist/public/app.js',
  sourcemap: false,
});

await cp('web/index.html', 'dist/public/index.html');
await cp('web/styles.css', 'dist/public/styles.css');
await cp('node_modules/@xterm/xterm/css/xterm.css', 'dist/public/xterm.css');
