import { build } from 'esbuild';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

// External: node built-ins + optional peer deps that may not be installed
const external = [
  'node:*',
  'fsevents',
  'better-sqlite3',
  // unified-channel optional adapter peer deps
  '@larksuiteoapi/node-sdk',
  '@line/bot-sdk',
  '@slack/bolt',
  '@slack/web-api',
  'botbuilder',
  'discord.js',
  'grammy',
  'irc-framework',
  'matrix-bot-sdk',
  'mattermost-client',
  'nostr-tools',
  'tmi.js',
  'twilio',
  'whatsapp-web.js',
  // acpx
  'acpx',
];

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/cli.js',
  external,
  banner: {
    js: '#!/usr/bin/env node',
  },
  define: {
    'process.env.npm_package_version': JSON.stringify(pkg.version),
  },
  // Keep dynamic requires working (e.g. node:sqlite via createRequire)
  keepNames: true,
});

console.log('Bundle complete: dist/cli.js');
