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

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  readyState: number;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  addEventListener?: (event: string, handler: (event: unknown) => void) => void;
};

export class OpenClawGatewayTransport implements ChannelTransport {
  public readonly id: string;

  private readonly config: OpenClawGatewayConfig;
  private ws?: WebSocketLike;
  private connected = false;
  private reqCounter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly inboundHandlers: Array<(msg: InboundMessage) => void | Promise<void>> = [];
  private reconnectTimer: NodeJS.Timeout | undefined;
  private destroyed = false;
  private connecting: Promise<void> | undefined;
  private reconnectAttempts = 0;

  public constructor(config: OpenClawGatewayConfig) {
    validateOpenClawUrl(config.gatewayUrl ?? 'ws://localhost:18789');
    this.config = config;
    this.id = config.id;
  }

  /** Connect to the OpenClaw Gateway. Call once on daemon start. */
  public async connect(): Promise<void> {
    await this.ensureConnected();
  }

  public async send(message: OutboundMessage): Promise<ReturnType<typeof createChannelMessageId>> {
    await this.ensureConnected();

    const target = message.address.conversationId || this.config.defaultTarget;
    const body = this.formatOutboundBody(message);

    if (!target) throw new Error('OpenClaw target is required');
    const result = (await this.req('chat.send', {
      target,
      text: body,
      ...(message.interventionId
        ? { idempotencyKey: `dark-kitchen:${message.interventionId}` }
        : {}),
      ...(message.actions && message.actions.length > 0
        ? {
            // OpenClaw supports structured choices on channels that allow it
            choices: message.actions.map((a) => ({ id: a.id, label: a.label, value: a.value })),
          }
        : {}),
    })) as { messageId?: string };

    if (!result?.messageId) throw new Error('OpenClaw response did not include a message ID');
    return createChannelMessageId(result.messageId);
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
    this.reconnectTimer = undefined;
    this.rejectPending(new Error('OpenClaw transport destroyed'));
    this.ws?.close();
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectAttempts = 0;
    const connecting = this.openWebSocket().finally(() => {
      this.connecting = undefined;
    });
    this.connecting = connecting;
    await connecting;
  }

  private async openWebSocket(): Promise<void> {
    const url = this.config.gatewayUrl ?? 'ws://localhost:18789';
    const token = this.config.authToken ?? process.env['OPENCLAW_GATEWAY_TOKEN'] ?? '';
    if (!isLoopback(url) && !token) {
      throw new Error('A remote OpenClaw Gateway requires authentication');
    }

    // Use the built-in WebSocket (Node 22+) or ws package
    const WS = await this.resolveWebSocket();

    return new Promise<void>((resolve, reject) => {
      const ws = new WS(url);
      this.ws = ws;

      let handshakeDone = false;
      const handshakeTimer = setTimeout(() => {
        if (!handshakeDone) {
          ws.close();
          reject(new Error('OpenClaw handshake timed out'));
        }
      }, 15_000);

      onWebSocket(ws, 'open', () => {
        // Wait for connect.challenge event before sending connect
      });

      onWebSocket(ws, 'message', (raw) => {
        void this.processSocketMessage(raw, {
          onConnected: () => {
            clearTimeout(handshakeTimer);
            this.connected = true;
            this.reconnectAttempts = 0;
            handshakeDone = true;
            resolve();
          },
          onConnectError: (error) => {
            clearTimeout(handshakeTimer);
            if (!handshakeDone) reject(error);
          },
          token,
        });
      });

      onWebSocket(ws, 'error', (rawError) => {
        clearTimeout(handshakeTimer);
        const error = rawError instanceof Error ? rawError : new Error('OpenClaw socket error');
        if (!handshakeDone) reject(error);
        this.connected = false;
        this.rejectPending(error);
        this.scheduleReconnect();
      });

      onWebSocket(ws, 'close', () => {
        clearTimeout(handshakeTimer);
        this.connected = false;
        this.rejectPending(new Error('OpenClaw socket closed'));
        if (!this.destroyed) this.scheduleReconnect();
      });
    });
  }

  private async processSocketMessage(
    raw: unknown,
    connect: { onConnected(): void; onConnectError(error: Error): void; token: string },
  ): Promise<void> {
    let frame: GatewayFrame;
    try {
      const payload = websocketPayload(raw);
      frame = JSON.parse(payload) as GatewayFrame;
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
          auth: connect.token ? { token: connect.token } : {},
          userAgent: 'dark-kitchen/0.1.0',
        },
      });
      this.pending.set(connectId, {
        resolve: () => {
          connect.onConnected();
        },
        reject: (err) => {
          connect.onConnectError(err);
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
        replyToMessageId?: string;
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
        ...(payload.replyToMessageId ? { replyToMessageId: payload.replyToMessageId } : {}),
      };

      for (const handler of this.inboundHandlers) {
        await handler(inbound);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const maxRetries = this.config.maxRetries ?? 5;
    if (this.reconnectAttempts >= maxRetries) return;
    const delayMs = Math.min(
      (this.config.retryDelayMs ?? 2_000) * 2 ** this.reconnectAttempts,
      30_000,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      const connecting = this.openWebSocket().finally(() => {
        this.connecting = undefined;
      });
      this.connecting = connecting;
      void connecting.catch(() => this.scheduleReconnect());
    }, delayMs);
  }

  private req(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`OpenClaw request ${method} timed out`));
        }
      }, 30_000);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.sendFrame({ type: 'req', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    });
  }

  private sendFrame(frame: GatewayFrame): void {
    if (!this.ws || (!this.connected && frame.type === 'req' && frame.method !== 'connect')) {
      throw new Error('OpenClaw socket is not connected');
    }
    this.ws.send(JSON.stringify(frame));
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

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async resolveWebSocket(): Promise<new (url: string) => WebSocketLike> {
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

function onWebSocket(
  socket: WebSocketLike,
  event: string,
  handler: (value?: unknown) => void,
): void {
  if (socket.on) {
    socket.on(event, (...args) => handler(args[0]));
    return;
  }
  if (socket.addEventListener) {
    socket.addEventListener(event, (rawEvent) => {
      const eventObject = rawEvent as { data?: unknown; error?: unknown };
      handler(event === 'message' ? eventObject.data : (eventObject.error ?? rawEvent));
    });
    return;
  }
  throw new Error('Unsupported WebSocket implementation');
}

function websocketPayload(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  }
  throw new Error('Unsupported WebSocket message payload');
}

function validateOpenClawUrl(rawUrl: string): void {
  const url = new URL(rawUrl);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid or credential-bearing OpenClaw Gateway URL');
  }
  if (!isLoopback(rawUrl) && url.protocol !== 'wss:') {
    throw new Error('Remote OpenClaw Gateways must use TLS');
  }
}

function isLoopback(rawUrl: string): boolean {
  const hostname = new URL(rawUrl).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
