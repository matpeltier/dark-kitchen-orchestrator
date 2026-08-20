/**
 * unified-channel transport for Dark Kitchen.
 *
 * Uses the `unified-channel` package (19 channels, 1 API) to send
 * intervention notifications and receive human replies — without requiring
 * any external gateway process.
 *
 * Supported channels (no public URL needed):
 *   - Telegram    → TELEGRAM_BOT_TOKEN
 *   - Discord     → DISCORD_BOT_TOKEN
 *   - Slack       → SLACK_BOT_TOKEN + SLACK_APP_TOKEN (Socket Mode)
 *
 * Supported channels (require macOS):
 *   - iMessage    → no token, reads macOS Messages DB
 *
 * Supported channels (require QR-code pairing, no token):
 *   - WhatsApp    → whatsapp-web.js (headless Chrome + WhatsApp Web QR scan)
 *
 * Usage (in config.yaml):
 *   channels:
 *     - kind: telegram
 *       tokenEnv: TELEGRAM_BOT_TOKEN
 *       defaultTarget: "123456789"   # your Telegram user/chat ID
 *
 * Adapters connect independently so one provider outage cannot take down the
 * others. Inbound messages are routed to ChannelGateway correlation logic.
 */

import { createChannelMessageId } from '@dark-kitchen/core';
import type { ChannelTransport, InboundMessage, OutboundMessage } from './gateway.js';

// ─── unified-channel types (lazy import) ─────────────────────────────────────

type UcChannelAdapter = {
  readonly channelId: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (msg: UcUnifiedMessage) => void | Promise<void>): void;
  send(message: {
    chatId: string;
    text: string;
    buttons?: UcButton[][];
  }): Promise<string | undefined>;
};

type UcUnifiedMessage = {
  id: string;
  channel: string;
  sender: { id: string; username?: string; displayName?: string };
  content: { type: string; text: string; callbackData?: string };
  timestamp: Date;
  chatId?: string;
  replyToId?: string;
};

type UcButton = { label: string; callbackData?: string; url?: string };

export type SupportedChannelKind = 'telegram' | 'discord' | 'slack' | 'imessage' | 'whatsapp';

export interface UnifiedChannelConfig {
  readonly kind: SupportedChannelKind;
  /** Environment variable name holding the bot token. */
  readonly tokenEnv?: string;
  /** Environment variable for secondary token (Slack app token). */
  readonly token2Env?: string;
  /** Default chat/user ID to send notifications to. */
  readonly defaultTarget?: string;
  /** Optional sender IDs allowed to resolve interventions. */
  readonly allowedSenderIds?: readonly string[];
  /** Telegram receive mode. Polling is the secure local default. */
  readonly telegramMode?: 'polling' | 'webhook';
  readonly telegramWebhookUrl?: string;
  readonly telegramWebhookPort?: number;
  readonly telegramWebhookPath?: string;
  readonly telegramWebhookSecret?: string;
}

export interface UnifiedChannelTransportOptions {
  readonly id: string;
  readonly channels: readonly UnifiedChannelConfig[];
}

/**
 * Multi-channel transport using `unified-channel`.
 * One instance covers all configured channels (Telegram, Discord, Slack, iMessage…).
 */
export class UnifiedChannelTransport implements ChannelTransport {
  public readonly id: string;

  private readonly options: UnifiedChannelTransportOptions;
  private readonly adapters = new Map<string, UcChannelAdapter>();
  private readonly inboundHandlers: Array<(msg: InboundMessage) => void | Promise<void>> = [];
  private msgCounter = 0;
  private started = false;
  private starting: Promise<void> | undefined;
  private adapterConstructors: Record<string, new (...args: unknown[]) => unknown> | undefined;

  public constructor(options: UnifiedChannelTransportOptions) {
    const kinds = options.channels.map((channel) => channel.kind);
    if (new Set(kinds).size !== kinds.length) {
      throw new Error('Only one configuration per channel kind is supported per transport');
    }
    this.id = options.id;
    this.options = options;
  }

  /**
   * Connect all configured channels. Call once on daemon start.
   * Non-blocking: channels connect asynchronously in background.
   */
  public async start(): Promise<void> {
    if (this.started) return;
    if (this.starting) return this.starting;
    const starting = this.startOnce().finally(() => {
      this.starting = undefined;
    });
    this.starting = starting;
    await starting;
  }

  private async startOnce(): Promise<void> {
    // Dynamic import to avoid requiring SDKs for unconfigured channels.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ucModule = (await import('unified-channel')) as any;
    const adapterConstructors = ucModule as Record<string, new (...args: unknown[]) => unknown>;
    this.adapterConstructors = adapterConstructors;

    // Connect independently and concurrently: a QR-pairing or network stall on
    // one provider must not delay Telegram or another healthy provider.
    const connected = (
      await Promise.all(
        this.options.channels.map((cfg) => this.connectConfiguredChannel(cfg, adapterConstructors)),
      )
    ).filter(Boolean).length;
    this.started = true;
    if (connected === 0) {
      this.started = false;
      throw new Error('No configured messaging channel could connect');
    }
  }

  public async send(message: OutboundMessage): Promise<ReturnType<typeof createChannelMessageId>> {
    if (!this.started) {
      await this.start();
    }

    const channelName = message.address.channel;
    const chatId = message.address.conversationId || this.getDefaultTarget(channelName);
    if (!chatId) {
      throw new Error(`No target configured for channel ${channelName}`);
    }

    // Build buttons from actions
    const buttons: UcButton[][] | undefined =
      message.actions && message.actions.length > 0
        ? [message.actions.map((a) => ({ label: a.label, callbackData: a.value }))]
        : undefined;

    let adapter = this.adapters.get(channelName);
    if (!adapter && this.adapterConstructors) {
      const config = this.options.channels.find((channel) => channel.kind === channelName);
      if (config) await this.connectConfiguredChannel(config, this.adapterConstructors);
      adapter = this.adapters.get(channelName);
    }
    if (!adapter) throw new Error(`Channel ${channelName} is not connected`);

    const body = fitChannelMessage(channelName, message.body);
    try {
      const sentMessageId = await adapter.send({
        chatId,
        text: body,
        ...(buttons ? { buttons } : {}),
      });
      // The real channel message id (e.g. Telegram's message_id) is what the
      // human quotes back in reply_to — use it for correlation, not a local
      // synthetic id.
      return createChannelMessageId(
        typeof sentMessageId === 'string' && sentMessageId
          ? sentMessageId
          : `uc-${channelName}-${++this.msgCounter}`,
      );
    } catch (error) {
      // Propagate delivery failure to ChannelGateway. It performs bounded retry
      // and reports a failed delivery without creating a false correlation.
      throw new Error(`Failed to send to ${channelName}:${chatId}: ${safeTransportError(error)}`);
    }
  }

  public subscribe(handler: (msg: InboundMessage) => void | Promise<void>): () => void {
    this.inboundHandlers.push(handler);
    return () => {
      const i = this.inboundHandlers.indexOf(handler);
      if (i >= 0) this.inboundHandlers.splice(i, 1);
    };
  }

  public async destroy(): Promise<void> {
    const adapters = [...this.adapters.values()];
    this.adapters.clear();
    this.started = false;
    this.adapterConstructors = undefined;
    await Promise.allSettled(adapters.map((adapter) => adapter.disconnect()));
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async connectConfiguredChannel(
    cfg: UnifiedChannelConfig,
    adapters: Record<string, new (...args: unknown[]) => unknown>,
  ): Promise<boolean> {
    if (this.adapters.has(cfg.kind)) return true;
    try {
      const adapter = await this.buildAdapter(adapters, cfg);
      if (!adapter) return false;
      adapter.onMessage(async (msg: UcUnifiedMessage) => {
        await this.handleUnifiedMessage(cfg, msg);
      });
      await adapter.connect();
      this.adapters.set(cfg.kind, adapter);
      return true;
    } catch (error) {
      process.stderr.write(
        `[channels] ${cfg.kind}: connection failed: ${safeTransportError(error)}\n`,
      );
      return false;
    }
  }

  private async buildAdapter(
    adapters: Record<string, new (...args: unknown[]) => unknown>,
    cfg: UnifiedChannelConfig,
  ): Promise<UcChannelAdapter | null> {
    const token = cfg.tokenEnv ? (process.env[cfg.tokenEnv] ?? '') : '';
    const token2 = cfg.token2Env ? (process.env[cfg.token2Env] ?? '') : '';

    // iMessage and WhatsApp authenticate without a token (local Messages DB /
    // WhatsApp Web QR-code pairing respectively).
    if (!token && cfg.kind !== 'imessage' && cfg.kind !== 'whatsapp') {
      process.stderr.write(
        `[channels] ${cfg.kind}: no token (${cfg.tokenEnv}) — channel skipped\n`,
      );
      return null;
    }

    switch (cfg.kind) {
      case 'telegram': {
        const { TelegramChannelAdapter } = await import('./telegram-adapter.js');
        return new TelegramChannelAdapter(token, {
          mode: cfg.telegramMode ?? 'polling',
          ...(cfg.defaultTarget ? { allowedChatIds: [cfg.defaultTarget] } : {}),
          ...(cfg.allowedSenderIds ? { allowedSenderIds: cfg.allowedSenderIds } : {}),
          ...(cfg.telegramWebhookUrl ? { webhookUrl: cfg.telegramWebhookUrl } : {}),
          ...(cfg.telegramWebhookPort !== undefined
            ? { webhookPort: cfg.telegramWebhookPort }
            : {}),
          ...(cfg.telegramWebhookPath ? { webhookPath: cfg.telegramWebhookPath } : {}),
          ...(cfg.telegramWebhookSecret ? { webhookSecret: cfg.telegramWebhookSecret } : {}),
        });
      }
      case 'discord': {
        const { DiscordAdapter } = adapters as unknown as {
          DiscordAdapter: new (token: string) => unknown;
        };
        return new DiscordAdapter(token) as UcChannelAdapter;
      }
      case 'slack': {
        const { SlackAdapter } = adapters as unknown as {
          SlackAdapter: new (botToken: string, appToken: string) => unknown;
        };
        if (!token2) {
          process.stderr.write(
            '[channels] slack: SLACK_APP_TOKEN required for Socket Mode — skipped\n',
          );
          return null;
        }
        return new SlackAdapter(token, token2) as UcChannelAdapter;
      }
      case 'imessage': {
        const { IMessageAdapter } = adapters as unknown as { IMessageAdapter: new () => unknown };
        return new IMessageAdapter() as UcChannelAdapter;
      }
      case 'whatsapp': {
        // Own adapter: unified-channel's version breaks on the CJS/ESM
        // interop of whatsapp-web.js (`LocalAuth is not a constructor`).
        const { WhatsAppAdapter } = await import('./whatsapp-adapter.js');
        return new WhatsAppAdapter(
          cfg.defaultTarget ? { selfChatId: cfg.defaultTarget } : {},
        ) as UcChannelAdapter;
      }
      default:
        process.stderr.write(`[channels] Unknown channel kind: ${String(cfg.kind)}\n`);
        return null;
    }
  }

  private getDefaultTarget(channelKind: string): string {
    return this.options.channels.find((c) => c.kind === channelKind)?.defaultTarget ?? '';
  }

  private async handleUnifiedMessage(
    cfg: UnifiedChannelConfig,
    msg: UcUnifiedMessage,
  ): Promise<void> {
    const conversationId = msg.chatId ?? msg.sender.id;
    // The configured outbound target doubles as a secure inbound conversation
    // allowlist. Optional sender IDs further restrict shared/group chats.
    if (msg.channel !== cfg.kind) return;
    if (cfg.defaultTarget && conversationId !== cfg.defaultTarget) return;
    if (cfg.allowedSenderIds && !cfg.allowedSenderIds.includes(msg.sender.id)) return;

    const timestamp = msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp);
    if (!Number.isFinite(timestamp.getTime())) return;
    const inbound: InboundMessage = {
      // Provider IDs are stable across polling/webhook redelivery and therefore
      // usable for replay protection. Do not replace them with local counters.
      id: createChannelMessageId(msg.id || `uc-in-${++this.msgCounter}`),
      address: { channel: msg.channel, conversationId },
      body: msg.content.text ?? '',
      receivedAt: timestamp.toISOString(),
      ...(msg.content.callbackData ? { actionValue: msg.content.callbackData } : {}),
      ...(msg.sender.id ? { senderId: msg.sender.id } : {}),
      ...(msg.replyToId ? { replyToMessageId: msg.replyToId } : {}),
    };
    for (const handler of this.inboundHandlers) await handler(inbound);
  }
}

export function fitChannelMessage(channel: string, body: string): string {
  const limit = channel === 'discord' ? 2_000 : channel === 'telegram' ? 4_096 : 16_000;
  if (body.length <= limit) return body;
  const marker = '\n\n… [message truncated by Dark Kitchen] …\n\n';
  const remaining = limit - marker.length;
  const headLength = Math.ceil(remaining * 0.6);
  return body.slice(0, headLength) + marker + body.slice(-(remaining - headLength));
}

function safeTransportError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? 'unknown error'))
    .replace(/((?:bearer|token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .slice(0, 500);
}
