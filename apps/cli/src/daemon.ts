/**
 * Dark Kitchen Daemon
 *
 * Initializes all services and runs the control plane. Prevents duplicate
 * instances via a lock file. Supports graceful shutdown.
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { DarkKitchenConfig } from '@dark-kitchen/config';
import { ConfigStore } from '@dark-kitchen/config';
import { SqliteRuntimeStore } from '@dark-kitchen/runtime-store-sqlite';
import { InterventionService } from '@dark-kitchen/runtime';
import { ChannelGateway } from '@dark-kitchen/channels';

export interface DaemonOptions {
  readonly projectRoot: string;
  readonly dataDir?: string;
  readonly foreground?: boolean;
  readonly logFormat?: 'human' | 'json';
}

export interface DaemonState {
  readonly pid: number;
  readonly startedAt: string;
  readonly projectRoot: string;
  readonly databasePath: string;
}

export class DarkKitchenDaemon {
  private readonly options: DaemonOptions;
  private readonly dataDir: string;
  private store?: SqliteRuntimeStore;
  private interventionService?: InterventionService;
  private channelGateway?: ChannelGateway;
  private running = false;
  private readonly shutdownCallbacks: Array<() => void | Promise<void>> = [];

  public constructor(options: DaemonOptions) {
    this.options = options;
    this.dataDir = options.dataDir ?? join(options.projectRoot, '.dark-kitchen', 'runtime');
  }

  public async start(): Promise<void> {
    if (this.running) throw new Error('Daemon is already running');

    await mkdir(this.dataDir, { recursive: true });

    // Duplicate instance guard
    const lockPath = join(this.dataDir, 'daemon.lock');
    await this.acquireLock(lockPath);

    const databasePath = join(this.dataDir, 'store.db');
    this.store = await SqliteRuntimeStore.open({ databasePath });
    this.interventionService = new InterventionService(this.store);
    this.channelGateway = new ChannelGateway();
    this.running = true;

    this.log('info', 'Daemon started', { pid: process.pid, dataDir: this.dataDir });

    // Register graceful shutdown
    const shutdown = () => this.stop().catch(() => {});
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    this.shutdownCallbacks.push(() => {
      process.off('SIGTERM', shutdown);
      process.off('SIGINT', shutdown);
    });

    // Write state file
    await this.writeState(databasePath);
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    this.log('info', 'Daemon shutting down gracefully');
    this.running = false;

    this.channelGateway?.destroy();
    this.store?.close();

    for (const cb of this.shutdownCallbacks) await cb();
    this.shutdownCallbacks.length = 0;

    // Remove lock and state
    const lockPath = join(this.dataDir, 'daemon.lock');
    await rm(lockPath, { force: true }).catch(() => {});
    await rm(join(this.dataDir, 'daemon.state.json'), { force: true }).catch(() => {});

    this.log('info', 'Daemon stopped');
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getStore(): SqliteRuntimeStore | undefined {
    return this.store;
  }

  public getInterventionService(): InterventionService | undefined {
    return this.interventionService;
  }

  public getChannelGateway(): ChannelGateway | undefined {
    return this.channelGateway;
  }

  private async acquireLock(lockPath: string): Promise<void> {
    try {
      const existing = await readFile(lockPath, 'utf8');
      const lockData = JSON.parse(existing) as { pid: number };
      // Check if the process is still running
      try {
        process.kill(lockData.pid, 0); // signal 0 = existence check
        throw new Error(
          `Another Dark Kitchen daemon is already running (pid ${lockData.pid}). ` +
          `Stop it first with 'dk stop'.`,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
          // Process does not exist — stale lock, take it
        } else {
          throw e;
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
  }

  private async writeState(databasePath: string): Promise<void> {
    const state: DaemonState = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectRoot: this.options.projectRoot,
      databasePath,
    };
    await writeFile(join(this.dataDir, 'daemon.state.json'), JSON.stringify(state, null, 2), 'utf8');
  }

  private log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    const format = this.options.logFormat ?? 'human';
    if (format === 'json') {
      process.stderr.write(JSON.stringify({ level, message, ...meta, t: new Date().toISOString() }) + '\n');
    } else {
      const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
      process.stderr.write(`[${level.toUpperCase()}] ${message}${metaStr}\n`);
    }
  }
}
