import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

// Workspace packages are bundled into the public CLI. Only intentionally
// discoverable runtime integrations stay external and are declared as normal
// registry dependencies in package.json (never workspace:* dependencies).
const external = [
  'node:*',
  'acpx',
  'acpx/*',
  'grammy',
  'jiti',
  'qrcode',
  'unified-channel',
  'whatsapp-web.js',
  'ws',
  'yaml',
];

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22.13',
  format: 'esm',
  outfile: 'dist/cli.js',
  external,
  define: {
    'process.env.DK_PACKAGE_VERSION': JSON.stringify(manifest.version),
  },
  keepNames: true,
});

process.stdout.write(`Bundled dark-kitchen ${manifest.version}\n`);
