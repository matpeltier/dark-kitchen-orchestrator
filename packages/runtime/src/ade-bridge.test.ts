import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SseDashboardAdapter } from './index.js';

describe('SseDashboardAdapter', () => {
  it('rejects cleanly when the port is already in use', async () => {
    // Occupy an ephemeral port with a raw server.
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;

    const dashboard = new SseDashboardAdapter({ port });
    await expect(dashboard.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    dashboard.destroy();
  });

  it('resolves and exposes the dashboard when the port is free', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const dashboard = new SseDashboardAdapter({ port });
    await expect(dashboard.start()).resolves.toBeUndefined();
    dashboard.destroy();
  });
});
