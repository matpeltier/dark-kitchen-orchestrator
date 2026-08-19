/**
 * ADEBridge — standard interface for live agent progress views.
 *
 * Dark Kitchen emits structured progress events during workflow execution.
 * ADEBridge forwards these events to any registered adapter:
 *
 *   1. Built-in SSE dashboard (bundled, runs on http://localhost:18800)
 *   2. acpx replay viewer (acpx live WebSocket transport)
 *   3. Orca / ctx / OpenAgentd (when they expose an API — via webhook adapter)
 *   4. Custom adapter (implement the AdeAdapter interface)
 *
 * The bridge is purely additive — Dark Kitchen works without any adapter.
 */

import { createServer } from 'node:http';
import type { ProgressEvent } from '@dark-kitchen/workflow-engine';

// ─── Standard event envelope ──────────────────────────────────────────────────

export interface AdeProgressEvent {
  readonly type:
    | 'run.start'
    | 'run.complete'
    | 'run.fail'
    | 'run.cancel'
    | 'step.start'
    | 'step.complete'
    | 'step.retry'
    | 'step.error'
    | 'agent.output'
    | 'intervention.created'
    | 'intervention.resolved';
  readonly runId: string;
  readonly taskId?: string;
  readonly role?: string;
  readonly callKey?: string;
  readonly output?: string;
  readonly error?: string;
  readonly attempt?: number;
  readonly timestamp: string;
}

// ─── Adapter interface ────────────────────────────────────────────────────────

export interface AdeAdapter {
  readonly id: string;
  emit(event: AdeProgressEvent): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

// ─── ADEBridge ────────────────────────────────────────────────────────────────

export class ADEBridge {
  private readonly adapters = new Map<string, AdeAdapter>();

  public register(adapter: AdeAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`ADE adapter "${adapter.id}" is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  public unregister(adapterId: string): void {
    const adapter = this.adapters.get(adapterId);
    adapter?.destroy?.();
    this.adapters.delete(adapterId);
  }

  /** Convert a workflow engine ProgressEvent to an ADE event and broadcast. */
  public emitWorkflowEvent(event: ProgressEvent, runId: string, taskId?: string): void {
    const adeEvent: AdeProgressEvent = {
      type: mapProgressKind(event.kind),
      runId,
      timestamp: new Date().toISOString(),
    };
    if (taskId) Object.assign(adeEvent, { taskId });
    if (event.role) Object.assign(adeEvent, { role: event.role });
    if (event.callKey) Object.assign(adeEvent, { callKey: event.callKey });
    if (event.attempt) Object.assign(adeEvent, { attempt: event.attempt });
    if (event.error)
      Object.assign(adeEvent, {
        error: event.error instanceof Error ? event.error.message : String(event.error),
      });
    for (const adapter of this.adapters.values()) {
      void adapter.emit(adeEvent);
    }
  }

  public emitAgentOutput(runId: string, taskId: string, role: string, output: string): void {
    const event: AdeProgressEvent = {
      type: 'agent.output',
      runId,
      taskId,
      role,
      output,
      timestamp: new Date().toISOString(),
    };
    for (const adapter of this.adapters.values()) {
      void adapter.emit(event);
    }
  }

  public emitRunEvent(type: AdeProgressEvent['type'], runId: string, taskId?: string): void {
    const event: AdeProgressEvent = { type, runId, timestamp: new Date().toISOString() };
    if (taskId) Object.assign(event, { taskId });
    for (const adapter of this.adapters.values()) {
      void adapter.emit(event);
    }
  }

  public async destroy(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.destroy?.();
    }
    this.adapters.clear();
  }
}

function mapProgressKind(kind: ProgressEvent['kind']): AdeProgressEvent['type'] {
  switch (kind) {
    case 'step.start':
      return 'step.start';
    case 'step.complete':
      return 'step.complete';
    case 'step.retry':
      return 'step.retry';
    case 'step.error':
      return 'step.error';
    case 'workflow.start':
      return 'run.start';
    case 'workflow.complete':
      return 'run.complete';
    case 'workflow.cancel':
      return 'run.cancel';
    default:
      return 'step.start';
  }
}

// ─── Built-in SSE dashboard adapter ──────────────────────────────────────────

export interface SseDashboardOptions {
  readonly port?: number;
  readonly host?: string;
}

/**
 * Bundled SSE dashboard — opens a minimal live view at http://localhost:18800
 * No external dependencies. Open it in any browser.
 */
export class SseDashboardAdapter implements AdeAdapter {
  public readonly id = 'sse-dashboard';
  private readonly options: SseDashboardOptions;
  private server?: ReturnType<typeof createServer>;
  private readonly clients = new Set<{
    write(data: string): void;
    end(): void;
  }>();
  private readonly eventBuffer: AdeProgressEvent[] = [];
  private readonly MAX_BUFFER = 500;

  public constructor(options: SseDashboardOptions = {}) {
    this.options = options;
  }

  public start(): void {
    const port = this.options.port ?? 18800;
    const host = this.options.host ?? '127.0.0.1';

    this.server = createServer((req, res) => {
      const url = req.url ?? '/';

      if (url === '/events') {
        // SSE endpoint
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        const client = { write: (d: string) => res.write(d), end: () => res.end() };
        this.clients.add(client);

        // Replay buffer for new connections
        for (const event of this.eventBuffer) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        req.on('close', () => {
          this.clients.delete(client);
        });
        return;
      }

      if (url === '/api/events') {
        // REST endpoint for polling clients
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(this.eventBuffer.slice(-100)));
        return;
      }

      // Serve the built-in dashboard HTML
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildDashboardHtml(port));
    });

    this.server.listen(port, host, () => {
      process.stderr.write(`[ADE] Dashboard: http://${host}:${port}\n`);
    });
  }

  public emit(event: AdeProgressEvent): void {
    // Buffer
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.MAX_BUFFER) this.eventBuffer.shift();

    // Broadcast to connected SSE clients
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(data);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  public destroy(): void {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.server?.close();
  }
}

// ─── acpx live viewer adapter ─────────────────────────────────────────────────

/**
 * Forwards Dark Kitchen events to the acpx replay viewer WebSocket.
 * Run: acpx flow viewer (or open the built-in viewer from acpx examples).
 */
export class AcpxLiveViewerAdapter implements AdeAdapter {
  public readonly id = 'acpx-live-viewer';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ws: any = null;
  private readonly viewerUrl: string;
  private reconnectTimer?: NodeJS.Timeout;
  private destroyed = false;

  public constructor(viewerUrl = 'ws://localhost:18900') {
    this.viewerUrl = viewerUrl;
  }

  public async connect(): Promise<void> {
    try {
      // Dynamic import to avoid requiring ws at build time
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsModule = (await import('ws' as string)) as any;
      const WS = wsModule.default ?? wsModule;
      const ws = new WS(this.viewerUrl);

      ws.on('open', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.ws = ws;
        ws.send(JSON.stringify({ type: 'dark-kitchen.connect', version: '0.1' }));
      });
      ws.on('error', () => {
        if (!this.destroyed) this.scheduleReconnect();
      });
      ws.on('close', () => {
        this.ws = null;
        if (!this.destroyed) this.scheduleReconnect();
      });
    } catch {
      // ws not available — adapter is no-op
    }
  }

  public emit(event: AdeProgressEvent): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (!this.ws || this.ws.readyState !== 1) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      this.ws.send(JSON.stringify({ type: 'dark-kitchen.event', event }));
    } catch {
      /* ignore */
    }
  }

  public destroy(): void {
    this.destroyed = true;
    clearTimeout(this.reconnectTimer);
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, 5000);
  }
}

// ─── Webhook adapter (Orca, ctx, custom) ─────────────────────────────────────

/**
 * HTTP webhook adapter — POST each event to any ADE that accepts webhooks.
 * Works with any ADE that has a REST API (including Orca when they ship one).
 */
export class WebhookAdeAdapter implements AdeAdapter {
  public readonly id: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;

  public constructor(id: string, url: string, headers: Record<string, string> = {}) {
    this.id = id;
    this.url = url;
    this.headers = headers;
  }

  public emit(event: AdeProgressEvent): void {
    // Fire-and-forget
    fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(event),
    }).catch(() => {
      /* non-fatal */
    });
  }
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────

function buildDashboardHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dark Kitchen — Live View</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'JetBrains Mono', 'Fira Code', monospace; background: #0d1117; color: #e6edf3; min-height: 100vh; }
  header { padding: 16px 24px; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 12px; }
  h1 { font-size: 16px; font-weight: 600; color: #f0f6fc; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: #238636; color: white; }
  .badge.connecting { background: #d29922; }
  .badge.disconnected { background: #da3633; }
  main { padding: 16px 24px; max-width: 1200px; }
  .stats { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; min-width: 120px; }
  .stat-value { font-size: 24px; font-weight: 700; color: #58a6ff; }
  .stat-label { font-size: 11px; color: #8b949e; margin-top: 2px; }
  .events { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  .events-header { padding: 10px 16px; border-bottom: 1px solid #30363d; font-size: 12px; color: #8b949e; display: flex; justify-content: space-between; }
  .event-list { max-height: 600px; overflow-y: auto; }
  .event { padding: 8px 16px; border-bottom: 1px solid #21262d; display: grid; grid-template-columns: 80px 120px 1fr 120px; gap: 8px; font-size: 12px; align-items: start; }
  .event:hover { background: #1c2128; }
  .event-type { font-weight: 600; }
  .event-type.step\\.start { color: #58a6ff; }
  .event-type.step\\.complete { color: #3fb950; }
  .event-type.step\\.error, .event-type.run\\.fail { color: #f85149; }
  .event-type.step\\.retry { color: #d29922; }
  .event-type.run\\.start { color: #58a6ff; }
  .event-type.run\\.complete { color: #3fb950; }
  .event-type.agent\\.output { color: #8b949e; }
  .event-type.intervention\\.created { color: #f0883e; }
  .event-type.intervention\\.resolved { color: #3fb950; }
  .event-role { color: #d2a8ff; }
  .event-detail { color: #8b949e; white-space: pre-wrap; word-break: break-all; }
  .event-time { color: #484f58; text-align: right; font-size: 11px; }
  .empty { padding: 48px; text-align: center; color: #484f58; }
</style>
</head>
<body>
<header>
  <span>🍳</span>
  <h1>Dark Kitchen</h1>
  <span class="badge connecting" id="status">connecting</span>
</header>
<main>
  <div class="stats">
    <div class="stat"><div class="stat-value" id="count-runs">0</div><div class="stat-label">Active runs</div></div>
    <div class="stat"><div class="stat-value" id="count-steps">0</div><div class="stat-label">Steps completed</div></div>
    <div class="stat"><div class="stat-value" id="count-interventions">0</div><div class="stat-label">Interventions</div></div>
    <div class="stat"><div class="stat-value" id="count-errors">0</div><div class="stat-label">Errors</div></div>
  </div>
  <div class="events">
    <div class="events-header">
      <span>Live events</span>
      <span id="event-count">0 events</span>
    </div>
    <div class="event-list" id="event-list">
      <div class="empty" id="empty-state">Waiting for events...</div>
    </div>
  </div>
</main>
<script>
  const list = document.getElementById('event-list');
  const emptyState = document.getElementById('empty-state');
  const badge = document.getElementById('status');
  let runs = new Set(), steps = 0, interventions = 0, errors = 0, total = 0;

  function addEvent(ev) {
    if (emptyState) emptyState.remove();
    total++;
    document.getElementById('event-count').textContent = total + ' events';

    if (ev.type === 'run.start') runs.add(ev.runId);
    if (ev.type === 'run.complete' || ev.type === 'run.fail') runs.delete(ev.runId);
    if (ev.type === 'step.complete') steps++;
    if (ev.type === 'intervention.created') interventions++;
    if (ev.type.includes('error') || ev.type === 'run.fail') errors++;

    document.getElementById('count-runs').textContent = runs.size;
    document.getElementById('count-steps').textContent = steps;
    document.getElementById('count-interventions').textContent = interventions;
    document.getElementById('count-errors').textContent = errors;

    const row = document.createElement('div');
    row.className = 'event';
    const ts = new Date(ev.timestamp).toLocaleTimeString();
    const detail = ev.output
      ? ev.output.slice(0, 120) + (ev.output.length > 120 ? '…' : '')
      : ev.callKey ? ev.callKey.split('/').slice(-2).join('/') : '';
    row.innerHTML =
      '<span class="event-type ' + ev.type.replace(/\\./g, '\\\\.') + '">' + ev.type + '</span>' +
      '<span class="event-role">' + (ev.role ?? ev.taskId ?? '') + '</span>' +
      '<span class="event-detail">' + detail.replace(/</g, '&lt;') + '</span>' +
      '<span class="event-time">' + ts + '</span>';
    list.insertBefore(row, list.firstChild);
    if (list.children.length > 200) list.removeChild(list.lastChild);
  }

  function connect() {
    const es = new EventSource('http://localhost:${port}/events');
    es.onopen = () => { badge.textContent = 'live'; badge.className = 'badge'; };
    es.onerror = () => { badge.textContent = 'disconnected'; badge.className = 'badge disconnected'; setTimeout(connect, 3000); };
    es.onmessage = (e) => { try { addEvent(JSON.parse(e.data)); } catch {} };
  }
  connect();
</script>
</body>
</html>`;
}
