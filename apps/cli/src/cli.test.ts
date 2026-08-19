import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DarkKitchenDaemon } from './daemon.js';
import { runDoctor } from './doctor.js';

describe('DarkKitchenDaemon', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = join(tmpdir(), `dk-daemon-${Date.now()}`);
    await mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('starts and stops without errors', async () => {
    const daemon = new DarkKitchenDaemon({ projectRoot });
    await daemon.start();
    expect(daemon.isRunning()).toBe(true);
    await daemon.stop();
    expect(daemon.isRunning()).toBe(false);
  });

  it('refuses duplicate start', async () => {
    const daemon1 = new DarkKitchenDaemon({ projectRoot });
    const daemon2 = new DarkKitchenDaemon({ projectRoot });
    await daemon1.start();
    await expect(daemon2.start()).rejects.toThrow(/already running/);
    await daemon1.stop();
  });

  it('exposes store and intervention service after start', async () => {
    const daemon = new DarkKitchenDaemon({ projectRoot });
    await daemon.start();
    expect(daemon.getStore()).toBeTruthy();
    expect(daemon.getInterventionService()).toBeTruthy();
    await daemon.stop();
  });

  it('preserves pending state across stop/restart', async () => {
    const daemon1 = new DarkKitchenDaemon({ projectRoot });
    await daemon1.start();

    // Create an intervention
    const intService = daemon1.getInterventionService()!;
    const intervention = await intService.create({
      scope: 'run',
      targetId: 'run-1' as never,
      kind: 'approval',
      summary: 'Test intervention',
    });

    await daemon1.stop();

    // Restart and check intervention is still there
    const daemon2 = new DarkKitchenDaemon({ projectRoot });
    await daemon2.start();
    const fetched = await daemon2.getStore()!.getIntervention(intervention.id);
    expect(fetched?.status).toBe('open');
    await daemon2.stop();
  });
});

describe('Doctor', () => {
  it('runs without errors', async () => {
    const report = await runDoctor(process.cwd());
    expect(report.checks.length).toBeGreaterThan(0);
    // Node check should be ok (we're running in Node 22+)
    const nodeCheck = report.checks.find((c) => c.name === 'node');
    expect(nodeCheck?.status).toBe('ok');
  });

  it('identifies git availability', async () => {
    const report = await runDoctor(process.cwd());
    const gitCheck = report.checks.find((c) => c.name === 'git');
    expect(gitCheck).toBeTruthy();
  });

  it('reports healthy for a valid workspace', async () => {
    const report = await runDoctor(process.cwd());
    // healthy means no errors (warns are ok)
    const errors = report.checks.filter((c) => c.status === 'error');
    // sqlite may error in test env without --experimental-sqlite flag
    const nonSqliteErrors = errors.filter((c) => c.name !== 'sqlite');
    expect(nonSqliteErrors).toHaveLength(0);
  });
});
