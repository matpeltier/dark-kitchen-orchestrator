/**
 * OpenClaw Gateway channel transport.
 *
 * Connects to a running OpenClaw Gateway (ws://localhost:18789) as an operator
 * client. OpenClaw routes messages to/from all configured channels
 * (Telegram, iMessage, WhatsApp, Slack, Discord, etc.) — Dark Kitchen only
 * speaks to the Gateway, never to individual channel APIs.
 *
 * Protocol reference: https://docs.openclaw.ai/gateway/protocol
 *
 * Frame shapes:
 *   Request:  { type:"req", id, method, params }
 *   Response: { type:"res", id, ok, payload|error }
 *   Event:    { type:"event", event, payload, seq? }
 */

import { createChannelMessageId } from '@dark-kitchen/core';
import type { ChannelTransport, InboundMessage, OutboundMessage } from './gateway.js';

export interface OpenClawGatewayConfig {
  readonly id: string;
  /**
   * WebSocket URL of the running OpenClaw Gateway.
   * Defaults to `ws://localhost:18789`.
   */
  readonly gatewayUrl?: string;
  /**
   * Gateway auth token (set via `gateway.auth.token` in openclaw config,
   * or via `OPENCLAW_GATEWAY_TOKEN` env var).
   */
  readonly authToken?: string;
  /**
   * Channel target to send outbound notifications to.
   * E.g. `telegram:@username`, `imessage:+1234567890`, `slack:channel-id`.
   * If omitted, messages are sent to the default conversation.
   */
  readonly defaultTarget?: string;
  /**
   * How long to wait before retrying a failed delivery (ms).
   * Defaults to exponential backoff starting at 2s.
   */
  readonly retryDelayMs?: number;
  readonly maxRetries?: number;
}

// ─── OpenClaw Gateway WebSocket client ───────────────────────────────────────

type GatewayFrame =
  | { type: 'req'; id: string; method: string; params: unknown }
  | {
      type: 'res';
      id: string;
      ok: boolean;
      payload?: unknown;
      error?: { code: string; message: string };
    }
  | { type: 'event'; event: string; payload: unknown; seq?: number };

type PendingRequest = {
  resolve(payload: unknown): void;
  reject(error: Error): void;
};

export class OpenClawGatewayTransport implements ChannelTransport {
  public readonly id: string;

  private readonly config: OpenClawGatewayConfig;
  private ws?: import('node:events').EventEmitter & {
    send(data: string): void;
    close(): void;
    readyState: number;
  };
  private connected = false;
  private reqCounter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly inboundHandlers: Array<(msg: InboundMessage) => void | Promise<void>> = [];
  private reconnectTimer?: NodeJS.Timeout;
  private destroyed = false;

  public constructor(config: OpenClawGatewayConfig) {
    this.config = config;
    this.id = config.id;
  }

  /** Connect to the OpenClaw Gateway. Call once on daemon start. */
  public async connect(): Promise<void> {
    await this.openWebSocket();
  }

  public async send(message: OutboundMessage): Promise<ReturnType<typeof createChannelMessageId>> {
    await this.ensureConnected();

    const target = message.address.conversationId || this.config.defaultTarget;
    const body = this.formatOutboundBody(message);

    try {
      const result = (await this.req('chat.send', {
        target,
        text: body,
        ...(message.actions && message.actions.length > 0
          ? {
              // OpenClaw supports structured choices on channels that allow it
              choices: message.actions.map((a) => ({ id: a.id, label: a.label, value: a.value })),
            }
          : {}),
      })) as { messageId?: string };

      return createChannelMessageId(result?.messageId ?? `oc-${Date.now()}`);
    } catch {
      // Channel outage — return a local ID, intervention remains pending
      return createChannelMessageId(`oc-local-${Date.now()}`);
    }
  }

  public subscribe(handler: (msg: InboundMessage) => void | Promise<void>): () => void {
    this.inboundHandlers.push(handler);
    return () => {
      const i = this.inboundHandlers.indexOf(handler);
      if (i >= 0) this.inboundHandlers.splice(i, 1);
    };
  }

  public destroy(): void {
    this.destroyed = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    await this.openWebSocket();
  }

  private async openWebSocket(): Promise<void> {
    const url = this.config.gatewayUrl ?? 'ws://localhost:18789';
    const token = this.config.authToken ?? process.env['OPENCLAW_GATEWAY_TOKEN'] ?? '';

    // Use the built-in WebSocket (Node 22+) or ws package
    const WS = await this.resolveWebSocket();

    return new Promise<void>((resolve, reject) => {
      const ws = new WS(url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.ws = ws as any;

      let handshakeDone = false;

      ws.on('open', () => {
        // Wait for connect.challenge event before sending connect
      });

      ws.on('message', async (raw: string | Buffer) => {
        let frame: GatewayFrame;
        try {
          frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as GatewayFrame;
        } catch {
          return;
        }

        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          // Send connect request with auth token
          const connectId = this.nextId();
          this.sendFrame({
            type: 'req',
            id: connectId,
            method: 'connect',
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              client: {
                id: 'dark-kitchen',
                version: '0.1.0',
                platform: process.platform,
                mode: 'operator',
              },
              role: 'operator',
              scopes: ['operator.read', 'operator.write'],
              caps: [],
              commands: [],
              permissions: {},
              auth: token ? { token } : {},
              userAgent: 'dark-kitchen/0.1.0',
            },
          });
          this.pending.set(connectId, {
            resolve: () => {
              this.connected = true;
              handshakeDone = true;
              resolve();
            },
            reject: (err) => {
              if (!handshakeDone) reject(err);
            },
          });
          return;
        }

        if (frame.type === 'res') {
          const pending = this.pending.get(frame.id);
          if (pending) {
            this.pending.delete(frame.id);
            if (frame.ok) {
              pending.resolve(frame.payload);
            } else {
              pending.reject(new Error(frame.error?.message ?? 'OpenClaw request failed'));
            }
          }
          return;
        }

        if (frame.type === 'event') {
          await this.handleGatewayEvent(frame);
        }
      });

      ws.on('error', (err: Error) => {
        if (!handshakeDone) reject(err);
        this.connected = false;
        this.scheduleReconnect();
      });

      ws.on('close', () => {
        this.connected = false;
        if (!this.destroyed) this.scheduleReconnect();
      });
    });
  }

  private async handleGatewayEvent(frame: GatewayFrame & { type: 'event' }): Promise<void> {
    // Handle inbound chat messages routed through OpenClaw
    if (frame.event === 'chat' || frame.event === 'session.message') {
      const payload = frame.payload as {
        messageId?: string;
        conversationId?: string;
        channel?: string;
        text?: string;
        action?: { id?: string; value?: string };
        sender?: { id?: string; name?: string };
      };

      if (!payload.text && !payload.action) return;

      const inbound: InboundMessage = {
        id: createChannelMessageId(payload.messageId ?? `oc-in-${Date.now()}`),
        address: {
          channel: payload.channel ?? this.id,
          conversationId: payload.conversationId ?? '',
        },
        body: payload.text ?? payload.action?.value ?? '',
        receivedAt: new Date().toISOString(),
        ...(payload.action?.value ? { actionValue: payload.action.value } : {}),
        ...(payload.sender?.id ? { senderId: payload.sender.id } : {}),
      };

      for (const handler of this.inboundHandlers) {
        await handler(inbound);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const delayMs = this.config.retryDelayMs ?? 5_000;
    this.reconnectTimer = setTimeout(() => {
      this.openWebSocket().catch(() => {
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private req(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      this.pending.set(id, { resolve, reject });
      this.sendFrame({ type: 'req', id, method, params });
      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`OpenClaw request ${method} timed out`));
        }
      }, 30_000);
    });
  }

  private sendFrame(frame: GatewayFrame): void {
    this.ws?.send(JSON.stringify(frame));
  }

  private nextId(): string {
    return `dk-${++this.reqCounter}-${Date.now()}`;
  }

  private formatOutboundBody(message: OutboundMessage): string {
    let text = message.body;
    if (message.actions && message.actions.length > 0) {
      text += '\n\n' + message.actions.map((a, i) => `${i + 1}. ${a.label}`).join('\n');
    }
    return text;
  }

  private async resolveWebSocket(): Promise<
    new (url: string) => import('node:events').EventEmitter & {
      on(event: string, handler: (...args: unknown[]) => void): void;
      send(data: string): void;
      close(): void;
      readyState: number;
    }
  > {
    // Node 22+ has built-in WebSocket
    if (typeof globalThis.WebSocket !== 'undefined') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return globalThis.WebSocket as any;
    }
    // Fallback: dynamic import of 'ws' package
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsModule = (await import('ws' as string)) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (wsModule.default ?? wsModule) as any;
    } catch {
      throw new Error(
        'No WebSocket implementation found. Install the `ws` package or use Node 22+.',
      );
    }
  }
}
