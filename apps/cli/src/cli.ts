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
import { runSetup } from './setup.js';

const args = process.argv.slice(2);
const command = args[0];
const projectRoot = resolve(process.cwd());

async function main(): Promise<void> {
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    print(process.env['DK_PACKAGE_VERSION'] ?? 'development');
    return;
  }
  switch (command) {
    case 'setup': {
      // Full interactive setup: installs acpx, creates config, runs doctor
      await runSetup(projectRoot);
      break;
    }
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
    case 'dashboard': {
      // Open the live dashboard in the default browser
      const port = args[1] ? parseInt(args[1], 10) : 18800;
      const url = `http://localhost:${port}`;
      print(`Dark Kitchen live dashboard: ${url}`);
      // Try to open in browser
      try {
        const { execSync } = await import('node:child_process');
        const open =
          process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'start'
              : 'xdg-open';
        execSync(`${open} ${url}`, { stdio: 'ignore' });
      } catch {
        print('Could not open browser automatically. Open the URL above manually.');
      }
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
      // Start the MCP server on stdio.
      // Reads config.yaml and wires up the real tracker adapter + config.
      const { startServer } = await import('@dark-kitchen/mcp');
      const { ConfigStore } = await import('@dark-kitchen/config');
      const { SqliteRuntimeStore } = await import('@dark-kitchen/runtime-store-sqlite');
      const { InterventionService } = await import('@dark-kitchen/runtime');

      let trackerAdapter;
      let interventionService;
      let config;

      try {
        const configStore = new ConfigStore({ projectRoot });
        config = await configStore.read();

        // Intervention service (needs SQLite store)
        const dataDir = join(projectRoot, '.dark-kitchen', 'runtime');
        const databasePath = join(dataDir, 'store.db');
        try {
          const store = await SqliteRuntimeStore.open({ databasePath });
          interventionService = new InterventionService(store);
        } catch {
          // SQLite not available (daemon not started) — interventions won't work
        }

        // Tracker adapter
        const trackerCfg = config.trackers?.[0];
        if (trackerCfg) {
          const token = trackerCfg.tokenEnv ? (process.env[trackerCfg.tokenEnv] ?? '') : '';
          if (trackerCfg.kind === 'github-issues') {
            const { GitHubIssuesAdapter } = await import('@dark-kitchen/tracker');
            trackerAdapter = new GitHubIssuesAdapter({
              owner: trackerCfg.owner ?? '',
              repo: trackerCfg.repo ?? '',
              token,
            });
          } else if (trackerCfg.kind === 'linear') {
            const { LinearTrackerAdapter } = await import('@dark-kitchen/tracker');
            const linConfig = { apiKey: token };
            if (trackerCfg.workspace) Object.assign(linConfig, { teamKey: trackerCfg.workspace });
            trackerAdapter = new LinearTrackerAdapter(linConfig);
          }
        }
      } catch (err) {
        // No config — MCP starts with empty context
        process.stderr.write(`[MCP] Warning: ${String(err)}\n`);
      }

      const mcpCtx: import('@dark-kitchen/mcp').McpContext = {};
      if (trackerAdapter) Object.assign(mcpCtx, { tracker: trackerAdapter });
      if (config) Object.assign(mcpCtx, { config });
      if (interventionService) Object.assign(mcpCtx, { interventionService });
      await startServer(mcpCtx);
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
    const template = [
      'version: 1',
      'trackers:',
      '  - id: gh-issues',
      '    kind: github-issues',
      '    owner: YOUR_ORG',
      '    repo: YOUR_REPO',
      '    tokenEnv: GITHUB_TOKEN',
      'repositories:',
      '  - id: main-repo',
      '    kind: github',
      '    owner: YOUR_ORG',
      '    repo: YOUR_REPO',
      '    defaultBranch: main',
      '    tokenEnv: GITHUB_TOKEN',
      'harnessProfiles:',
      '  - managed: true',
      '    id: codex',
      '    kind: codex',
      'roles:',
      '  - id: implementer',
      '    harnessProfileId: codex',
      '  - id: reviewer',
      '    harnessProfileId: codex',
      '  - id: fixer',
      '    harnessProfileId: codex',
      '  - id: repository-tester',
      '    harnessProfileId: codex',
      'workflows:',
      '  - id: default',
      '    builtin: default',
      '    roles: [implementer, reviewer, fixer, repository-tester]',
    ].join('\n');
    await writeFile(configPath, template + '\n', 'utf8');
    print('Created .dark-kitchen/config.yaml — edit YOUR_ORG and YOUR_REPO.');
    print('For interactive setup, run: dk setup');
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
    if (daemon.dashboardPort) {
      print(`Live dashboard: http://localhost:${daemon.dashboardPort}`);
    }
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
  print(
    'Log streaming requires a running daemon. Check stderr output from `dk start --foreground`.',
  );
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
  print(
    'Interventions command requires a running daemon. Use Dark Kitchen MCP or API to manage interventions.',
  );
}

async function cmdCapabilities(): Promise<void> {
  const sub = args[1];
  if (sub === 'list') {
    print(
      'Capability list requires an active config. Use `dk config get` to see configured providers.',
    );
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
Dark Kitchen — autonomous coding agent control plane

Usage: dk <command> [options]
       npx dark-kitchen <command>

Getting started (one command):
  dk setup          Interactive setup: installs acpx, creates config, runs doctor

Commands:
  setup             Interactive setup wizard (installs deps, creates config)
  init              Create .dark-kitchen/config.yaml from a template (non-interactive)
  start             Start the Dark Kitchen daemon (+ live dashboard on :18800)
  stop              Stop the running daemon
  status            Show daemon status
  dashboard [port]  Open the live agent progress dashboard in browser
  doctor            Check system health and dependencies
  logs              Stream daemon logs (daemon must be running with --foreground)
  config get        Print current configuration
  runs              List active/recent runs
  agents            List agent sessions
  interventions     List open interventions
  capabilities      list | ensure <id>
  cleanup           Remove released worktrees and stale data
  mcp               Start as an MCP server on stdio (for Cursor integration)

Options:
  --foreground      Run daemon in foreground (Ctrl+C to stop)
  --json            Use JSON log format

Examples:
  dk setup                        # First-time setup
  export GITHUB_TOKEN=ghp_...
  dk start --foreground           # Start and see logs
  dk doctor                       # Check health at any time
`);
}

await main();
