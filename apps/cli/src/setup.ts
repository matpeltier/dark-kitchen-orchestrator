/**
 * Dark Kitchen setup — installs required dependencies and runs interactive init.
 *
 * Run once:  dk setup
 * Or:        npx dark-kitchen setup
 *
 * What it does:
 *  1. Checks Node.js version (requires 22.13+)
 *  2. Checks git
 *  3. Installs acpx globally if missing
 *  4. Prompts for tracker/SCM/agent config interactively
 *  5. Writes .dark-kitchen/config.yaml
 *  6. Runs doctor to confirm health
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { dump as yamlDump } from 'js-yaml';
import type { DarkKitchenConfig } from '@dark-kitchen/config';
import { runDoctor, formatDoctorReport } from './doctor.js';

export async function runSetup(projectRoot: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    print('\n🍳 Dark Kitchen setup\n');

    // ── 1. Node version ─────────────────────────────────────────────────────
    const nodeMajor = parseInt(process.version.slice(1).split('.')[0] ?? '0', 10);
    if (nodeMajor < 22) {
      printErr(`Node ${process.version} detected. Dark Kitchen requires Node >= 22.13.`);
      printErr('Install it from https://nodejs.org or use nvm/fnm.');
      process.exit(1);
    }
    print(`✓ Node ${process.version}`);

    // ── 2. Git ──────────────────────────────────────────────────────────────
    try {
      execSync('git --version', { stdio: 'ignore' });
      print('✓ git');
    } catch {
      printErr('git not found. Install git from https://git-scm.com');
      process.exit(1);
    }

    // ── 3. acpx ─────────────────────────────────────────────────────────────
    const acpxInstalled = isCommandAvailable('acpx');
    if (!acpxInstalled) {
      print('\nacpx not found — installing globally...');
      const result = spawnSync('npm', ['install', '-g', 'acpx'], {
        stdio: 'inherit',
        shell: false,
      });
      if (result.status !== 0) {
        printErr('Failed to install acpx. Try manually: npm install -g acpx');
        process.exit(1);
      }
      print('✓ acpx installed');
    } else {
      print('✓ acpx');
    }

    // ── 4. Check if config already exists ───────────────────────────────────
    const configDir = join(projectRoot, '.dark-kitchen');
    const configPath = join(configDir, 'config.yaml');
    if (existsSync(configPath)) {
      const overwrite = await rl.question(
        '\n.dark-kitchen/config.yaml already exists. Overwrite? [y/N] ',
      );
      if (overwrite.toLowerCase() !== 'y') {
        print('Skipping config. Run `dk doctor` to verify your setup.');
        return;
      }
    }

    // ── 5. Interactive config ────────────────────────────────────────────────
    print('\n── Tracker setup ──────────────────────────────────────────────');
    print('Supported trackers: github-issues, linear, jira');
    const trackerKind =
      (await rl.question('Tracker type [github-issues]: ')).trim() || 'github-issues';

    let trackerConfig: DarkKitchenConfig['trackers'] = [];
    let repoOwner = '';
    let repoName = '';

    if (trackerKind === 'github-issues') {
      repoOwner = (await rl.question('GitHub owner (org or user): ')).trim();
      repoName = (await rl.question('GitHub repo name: ')).trim();
      print('Set GITHUB_TOKEN env var with a token that has repo + issues access.');
      trackerConfig = [
        {
          id: 'gh-issues',
          kind: 'github-issues',
          owner: repoOwner,
          repo: repoName,
          tokenEnv: 'GITHUB_TOKEN',
        },
      ];
    } else if (trackerKind === 'linear') {
      const workspace = (await rl.question('Linear workspace name: ')).trim();
      print('Set LINEAR_API_KEY env var with your Linear API key.');
      trackerConfig = [{ id: 'linear', kind: 'linear', workspace, tokenEnv: 'LINEAR_API_KEY' }];
    } else if (trackerKind === 'jira') {
      const project = (await rl.question('Jira project key (e.g. ENG): ')).trim();
      print('Set JIRA_TOKEN and JIRA_EMAIL env vars.');
      trackerConfig = [{ id: 'jira', kind: 'jira', project, tokenEnv: 'JIRA_TOKEN' }];
    }

    print('\n── SCM setup (source control) ──────────────────────────────────');
    if (!repoOwner) repoOwner = (await rl.question('GitHub owner: ')).trim();
    if (!repoName) repoName = (await rl.question('GitHub repo name: ')).trim();
    const defaultBranch = (await rl.question('Default branch [main]: ')).trim() || 'main';

    print('\n── Agent (harness) setup ───────────────────────────────────────');
    print('Available ACP agents: codex, claude-code, gemini-cli');
    const agentKind = (await rl.question('Agent type [codex]: ')).trim() || 'codex';

    print('\n── Optional: OpenClaw Gateway (for Telegram/iMessage/WhatsApp/Slack) ──');
    print("Skip this if you don't use OpenClaw. Interventions will be logged to console.");
    const useOpenclaw =
      (await rl.question('Connect to OpenClaw Gateway? [y/N]: ')).toLowerCase() === 'y';
    let openclawUrl = '';
    if (useOpenclaw) {
      openclawUrl =
        (await rl.question('OpenClaw Gateway URL [ws://localhost:18789]: ')).trim() ||
        'ws://localhost:18789';
      print('Set OPENCLAW_GATEWAY_TOKEN env var if your Gateway requires auth.');
    }

    print('\n── Merge policy ────────────────────────────────────────────────');
    const autoMerge =
      (await rl.question('Auto-merge PRs when CI passes? [y/N]: ')).toLowerCase() === 'y';
    const ciCheck =
      (await rl.question('Required CI check name (leave blank to skip) [ci]: ')).trim() || '';

    // ── 6. Build config object ───────────────────────────────────────────────
    const config: DarkKitchenConfig = {
      version: 1,
      trackers: trackerConfig,
      repositories: [
        {
          id: 'main-repo',
          kind: 'github',
          owner: repoOwner,
          repo: repoName,
          defaultBranch,
          tokenEnv: 'GITHUB_TOKEN',
        },
      ],
      harnessProfiles: [
        {
          managed: true,
          id: agentKind,
          kind: agentKind,
        },
      ],
      roles: [
        { id: 'implementer', harnessProfileId: agentKind },
        { id: 'reviewer', harnessProfileId: agentKind },
      ],
      workflows: [
        {
          id: 'default',
          file: '.dark-kitchen/workflows/default.ts',
          roles: ['implementer', 'reviewer'],
        },
      ],
      ...(autoMerge
        ? {
            mergePolicy: {
              strategy: 'squash',
              ...(ciCheck ? { requiredChecks: [ciCheck] } : {}),
              requireApproval: false,
              deleteHeadBranchAfterMerge: true,
            },
          }
        : {}),
      ...(useOpenclaw && openclawUrl
        ? {
            channels: [
              {
                id: 'openclaw',
                kind: 'openclaw' as never,
                url: openclawUrl,
                tokenEnv: 'OPENCLAW_GATEWAY_TOKEN',
              },
            ],
          }
        : {}),
    };

    // ── 7. Write config ──────────────────────────────────────────────────────
    await mkdir(configDir, { recursive: true });
    const yaml = yamlDump(config, { lineWidth: 120, quotingType: '"' });
    await writeFile(configPath, yaml, 'utf8');

    // ── 8. Write .env.example ────────────────────────────────────────────────
    const envExample = [
      '# Dark Kitchen — copy to .env and fill in values',
      `GITHUB_TOKEN=ghp_...`,
      trackerKind === 'linear' ? 'LINEAR_API_KEY=lin_api_...' : '',
      trackerKind === 'jira' ? 'JIRA_TOKEN=...\nJIRA_EMAIL=you@example.com' : '',
      useOpenclaw ? 'OPENCLAW_GATEWAY_TOKEN=...' : '',
    ]
      .filter(Boolean)
      .join('\n');
    await writeFile(join(projectRoot, '.dark-kitchen', '.env.example'), envExample + '\n', 'utf8');

    print('\n✓ .dark-kitchen/config.yaml written');
    print('✓ .dark-kitchen/.env.example written');

    // ── 9. Add to .gitignore ─────────────────────────────────────────────────
    const gitignorePath = join(projectRoot, '.gitignore');
    try {
      const existing = await readFile(gitignorePath, 'utf8');
      const toAdd: string[] = [];
      if (!existing.includes('.dark-kitchen/runtime/')) toAdd.push('.dark-kitchen/runtime/');
      if (!existing.includes('.dark-kitchen/.env')) toAdd.push('.dark-kitchen/.env');
      if (toAdd.length > 0) {
        await writeFile(
          gitignorePath,
          existing + '\n# Dark Kitchen runtime\n' + toAdd.join('\n') + '\n',
          'utf8',
        );
        print('✓ .gitignore updated (runtime state and secrets excluded)');
      }
    } catch {
      // no .gitignore — create one
      await writeFile(
        gitignorePath,
        '# Dark Kitchen runtime\n.dark-kitchen/runtime/\n.dark-kitchen/.env\n',
        'utf8',
      );
      print('✓ .gitignore created');
    }

    // ── 10. Doctor ───────────────────────────────────────────────────────────
    print('\n── Health check ────────────────────────────────────────────────');
    const report = await runDoctor(projectRoot);
    print(formatDoctorReport(report));

    print('\n✓ Setup complete!');
    print('\nNext steps:');
    print('  1. Set your env vars (see .dark-kitchen/.env.example)');
    print('  2. In GitHub Issues, add the label "dk:ready" to tasks you want automated');
    print('  3. Run:  dk start --foreground');
    print('     Or for background: dk start');
  } finally {
    rl.close();
  }
}

function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function print(msg: string): void {
  process.stdout.write(msg + '\n');
}

function printErr(msg: string): void {
  process.stderr.write(msg + '\n');
}
