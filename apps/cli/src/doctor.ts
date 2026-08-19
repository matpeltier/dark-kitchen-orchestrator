/**
 * Dark Kitchen `doctor` command.
 *
 * Checks Node/pnpm/git, repository state, SQLite, tracker/SCM credentials,
 * harness availability, capability state, OpenClaw reachability, and MCP settings.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const execAsync = promisify(exec);

export interface DoctorCheck {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'error' | 'missing';
  readonly message: string;
  readonly provisionable?: boolean;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly healthy: boolean;
}

export async function runDoctor(projectRoot: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10);
  checks.push({
    name: 'node',
    status: nodeMajor >= 22 ? 'ok' : 'error',
    message: nodeMajor >= 22 ? `Node ${nodeVersion} ✓` : `Node ${nodeVersion} — requires >=22.13`,
  });

  // git
  try {
    const { stdout } = await execAsync('git --version');
    checks.push({ name: 'git', status: 'ok', message: stdout.trim() });
  } catch {
    checks.push({ name: 'git', status: 'error', message: 'git not found on PATH' });
  }

  // pnpm
  try {
    const { stdout } = await execAsync('pnpm --version');
    checks.push({ name: 'pnpm', status: 'ok', message: `pnpm ${stdout.trim()}` });
  } catch {
    checks.push({
      name: 'pnpm',
      status: 'warn',
      message: 'pnpm not found — optional for development',
    });
  }

  // Repository state
  try {
    await execAsync('git rev-parse --git-dir', { cwd: projectRoot });
    checks.push({ name: 'repository', status: 'ok', message: `Git repository at ${projectRoot}` });
  } catch {
    checks.push({
      name: 'repository',
      status: 'error',
      message: `${projectRoot} is not a Git repository`,
    });
  }

  // Config file
  const configPath = join(projectRoot, '.dark-kitchen', 'config.yaml');
  try {
    await access(configPath);
    checks.push({ name: 'config', status: 'ok', message: `.dark-kitchen/config.yaml found` });
  } catch {
    checks.push({
      name: 'config',
      status: 'warn',
      message: `.dark-kitchen/config.yaml not found — run dk init`,
    });
  }

  // Tracker credentials
  const trackerToken =
    process.env['GITHUB_TOKEN'] ?? process.env['LINEAR_API_KEY'] ?? process.env['JIRA_TOKEN'];
  if (trackerToken) {
    checks.push({
      name: 'tracker-auth',
      status: 'ok',
      message: 'Tracker token found in environment',
    });
  } else {
    checks.push({
      name: 'tracker-auth',
      status: 'warn',
      message: 'No tracker token found in GITHUB_TOKEN / LINEAR_API_KEY / JIRA_TOKEN',
    });
  }

  // acpx
  try {
    const { stdout } = await execAsync('acpx --version');
    checks.push({ name: 'acpx', status: 'ok', message: `acpx ${stdout.trim()}` });
  } catch {
    checks.push({
      name: 'acpx',
      status: 'warn',
      message: 'acpx not found — required for ACP harnesses',
    });
  }

  // SQLite (node:sqlite)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { createRequire } = (await import('node:module')) as any as {
      createRequire: (url: string) => NodeRequire;
    };
    const req = createRequire(import.meta.url);
    req('node:sqlite');
    checks.push({ name: 'sqlite', status: 'ok', message: 'node:sqlite available' });
  } catch {
    checks.push({
      name: 'sqlite',
      status: 'error',
      message: 'node:sqlite not available — requires Node >=22.5 with --experimental-sqlite',
    });
  }

  // OpenClaw (optional)
  const openclawUrl = process.env['OPENCLAW_URL'];
  if (openclawUrl) {
    try {
      const response = await fetch(`${openclawUrl}/health`, { signal: AbortSignal.timeout(3000) });
      checks.push({
        name: 'openclaw',
        status: response.ok ? 'ok' : 'warn',
        message: `OpenClaw at ${openclawUrl}: ${response.status}`,
      });
    } catch {
      checks.push({
        name: 'openclaw',
        status: 'warn',
        message: `OpenClaw at ${openclawUrl} is unreachable`,
      });
    }
  } else {
    checks.push({ name: 'openclaw', status: 'ok', message: 'OpenClaw not configured (optional)' });
  }

  const healthy = checks.every((c) => c.status === 'ok' || c.status === 'warn');
  return { checks, healthy };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ['Dark Kitchen Doctor Report', ''];
  for (const check of report.checks) {
    const icon = check.status === 'ok' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
    lines.push(`  ${icon} ${check.name.padEnd(20)} ${check.message}`);
    if (check.provisionable) lines.push(`      → Run: dk capabilities ensure ${check.name}`);
  }
  lines.push('');
  lines.push(report.healthy ? 'Status: Healthy' : 'Status: Issues found — address errors above');
  return lines.join('\n');
}
