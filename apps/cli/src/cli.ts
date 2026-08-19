#!/usr/bin/env node
/**
 * Dark Kitchen CLI entry point.
 *
 * Commands: init, start, stop, status, doctor, logs, config,
 *           runs, agents, interventions, capabilities, cleanup
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DarkKitchenDaemon } from './daemon.js';
import { runDoctor, formatDoctorReport } from './doctor.js';
import { SAMPLE_GITHUB_ISSUES_CONFIG } from '@dark-kitchen/config';
import { dump as yamlDump } from 'js-yaml';

const args = process.argv.slice(2);
const command = args[0];
const projectRoot = resolve(process.cwd());

async function main(): Promise<void> {
  switch (command) {
    case 'init': {
      await cmdInit();
      break;
    }
    case 'start': {
      await cmdStart();
      break;
    }
    case 'stop': {
      await cmdStop();
      break;
    }
    case 'status': {
      await cmdStatus();
      break;
    }
    case 'doctor': {
      await cmdDoctor();
      break;
    }
    case 'logs': {
      await cmdLogs();
      break;
    }
    case 'config': {
      await cmdConfig();
      break;
    }
    case 'interventions': {
      await cmdInterventions();
      break;
    }
    case 'runs': {
      print('Runs command — connect to daemon runtime store for live data.');
      break;
    }
    case 'agents': {
      print('Agents command — connect to daemon runtime store for live data.');
      break;
    }
    case 'capabilities': {
      await cmdCapabilities();
      break;
    }
    case 'cleanup': {
      await cmdCleanup();
      break;
    }
    case 'mcp': {
      // Start the MCP server (used when running as a Cursor/MCP server)
      const { startServer } = await import('@dark-kitchen/mcp');
      await startServer({});
      break;
    }
    default: {
      printHelp();
      process.exit(command ? 1 : 0);
    }
  }
}

async function cmdInit(): Promise<void> {
  const configDir = join(projectRoot, '.dark-kitchen');
  const configPath = join(configDir, 'config.yaml');
  await mkdir(configDir, { recursive: true });

  try {
    await readFile(configPath, 'utf8');
    print('.dark-kitchen/config.yaml already exists. Use `dk config` to edit.');
  } catch {
    const yaml = yamlDump(SAMPLE_GITHUB_ISSUES_CONFIG, { lineWidth: 120 });
    await writeFile(configPath, yaml, 'utf8');
    print('Created .dark-kitchen/config.yaml with a sample GitHub Issues + GitHub SCM configuration.');
    print('Edit it to match your project before running `dk start`.');
  }
}

async function cmdStart(): Promise<void> {
  const daemon = new DarkKitchenDaemon({
    projectRoot,
    logFormat: args.includes('--json') ? 'json' : 'human',
    foreground: args.includes('--foreground'),
  });

  try {
    await daemon.start();
    print('Dark Kitchen daemon started.');
    if (args.includes('--foreground')) {
      print('Running in foreground. Press Ctrl+C to stop.');
      await new Promise<void>((resolve) => {
        process.on('SIGTERM', resolve);
        process.on('SIGINT', resolve);
      });
      await daemon.stop();
    }
  } catch (err) {
    printErr(String(err));
    process.exit(1);
  }
}

async function cmdStop(): Promise<void> {
  const statePath = join(projectRoot, '.dark-kitchen', 'runtime', 'daemon.state.json');
  try {
    const stateText = await readFile(statePath, 'utf8');
    const state = JSON.parse(stateText) as { pid: number };
    process.kill(state.pid, 'SIGTERM');
    print(`Sent SIGTERM to daemon (pid ${state.pid})`);
  } catch {
    print('No running daemon found.');
  }
}

async function cmdStatus(): Promise<void> {
  const statePath = join(projectRoot, '.dark-kitchen', 'runtime', 'daemon.state.json');
  try {
    const stateText = await readFile(statePath, 'utf8');
    const state = JSON.parse(stateText) as { pid: number; startedAt: string };
    print(`Daemon running (pid ${state.pid}, started ${state.startedAt})`);
  } catch {
    print('Daemon is not running.');
  }
}

async function cmdDoctor(): Promise<void> {
  const report = await runDoctor(projectRoot);
  print(formatDoctorReport(report));
  process.exit(report.healthy ? 0 : 1);
}

async function cmdLogs(): Promise<void> {
  print('Log streaming requires a running daemon. Check stderr output from `dk start --foreground`.');
}

async function cmdConfig(): Promise<void> {
  const sub = args[1];
  if (sub === 'get') {
    const configPath = join(projectRoot, '.dark-kitchen', 'config.yaml');
    try {
      const content = await readFile(configPath, 'utf8');
      print(content);
    } catch {
      printErr('.dark-kitchen/config.yaml not found. Run `dk init` first.');
      process.exit(1);
    }
  } else {
    print('Usage: dk config get');
  }
}

async function cmdInterventions(): Promise<void> {
  print('Interventions command requires a running daemon. Use Dark Kitchen MCP or API to manage interventions.');
}

async function cmdCapabilities(): Promise<void> {
  const sub = args[1];
  if (sub === 'list') {
    print('Capability list requires an active config. Use `dk config get` to see configured providers.');
  } else if (sub === 'ensure') {
    print(`Capability ensure: connect to Dark Kitchen API to provision "${args[2] ?? '<id>'}"`);
  } else {
    print('Usage: dk capabilities list | dk capabilities ensure <id>');
  }
}

async function cmdCleanup(): Promise<void> {
  print('Cleanup: removes released worktrees and stale runtime data. Requires a running daemon.');
}

function print(msg: string): void {
  process.stdout.write(msg + '\n');
}

function printErr(msg: string): void {
  process.stderr.write(msg + '\n');
}

function printHelp(): void {
  print(`
Dark Kitchen CLI

Usage: dk <command> [options]

Commands:
  init              Create .dark-kitchen/config.yaml from a sample template
  start             Start the Dark Kitchen daemon
  stop              Stop the running daemon
  status            Show daemon status
  doctor            Check system health and dependencies
  logs              Stream daemon logs
  config get        Print current configuration
  runs              List active/recent runs
  agents            List agent sessions
  interventions     List open interventions
  capabilities      list | ensure <id>
  cleanup           Remove released worktrees and stale data
  mcp               Start as an MCP server (stdio)

Options:
  --foreground      Run daemon in foreground (default: background)
  --json            Use JSON log format
`);
}

await main();
