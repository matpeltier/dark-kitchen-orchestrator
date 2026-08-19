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
 * Supported channels (require public webhook URL):
 *   - WhatsApp    → WHATSAPP_WEBHOOK_URL
 *
 * Usage (in config.yaml):
 *   channels:
 *     - kind: telegram
 *       tokenEnv: TELEGRAM_BOT_TOKEN
 *       defaultTarget: "123456789"   # your Telegram user/chat ID
 *
 * The transport starts a single ChannelManager shared across all configured
 * channels. Inbound messages from any channel are routed to the intervention
 * correlation logic in ChannelGateway.
 */

import { createChannelMessageId } from '@dark-kitchen/core';
import type { ChannelTransport, InboundMessage, OutboundMessage } from './gateway.js';

// ─── unified-channel types (lazy import) ─────────────────────────────────────

type UcChannelManager = {
  addChannel(adapter: unknown): void;
  onMessage(handler: (msg: UcUnifiedMessage) => void | Promise<void>): void;
  run(): Promise<void>;
  shutdown(): Promise<void>;
  send(
    channel: string,
    chatId: string,
    text: string,
    opts?: { buttons?: UcButton[][] },
  ): Promise<void>;
};

type UcUnifiedMessage = {
  id: string;
  channel: string;
  sender: { id: string; username?: string; displayName?: string };
  content: { type: string; text: string; callbackData?: string };
  timestamp: Date;
  chatId?: string;
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
  private manager?: UcChannelManager;
  private readonly inboundHandlers: Array<(msg: InboundMessage) => void | Promise<void>> = [];
  private msgCounter = 0;
  private started = false;

  public constructor(options: UnifiedChannelTransportOptions) {
    this.id = options.id;
    this.options = options;
  }

  /**
   * Connect all configured channels. Call once on daemon start.
   * Non-blocking: channels connect asynchronously in background.
   */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Dynamic import to avoid Vite/build-time resolution issues
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ucModule = (await import('unified-channel')) as any;
    const { ChannelManager } = ucModule as { ChannelManager: new () => UcChannelManager };
    const adapters = ucModule as Record<string, new (...args: unknown[]) => unknown>;

    const manager = new ChannelManager() as UcChannelManager;

    for (const cfg of this.options.channels) {
      const adapter = await this.buildAdapter(adapters, cfg);
      if (adapter) manager.addChannel(adapter);
    }

    manager.onMessage(async (msg: UcUnifiedMessage) => {
      const inbound: InboundMessage = {
        id: createChannelMessageId(`uc-in-${++this.msgCounter}`),
        address: {
          channel: msg.channel,
          conversationId: msg.chatId ?? msg.sender.id,
        },
        body: msg.content.text,
        receivedAt: msg.timestamp.toISOString(),
        ...(msg.content.callbackData ? { actionValue: msg.content.callbackData } : {}),
        ...(msg.sender.id ? { senderId: msg.sender.id } : {}),
      };
      for (const handler of this.inboundHandlers) await handler(inbound);
    });

    this.manager = manager;

    // Start in background — don't block daemon startup
    manager.run().catch((err: unknown) => {
      process.stderr.write(`[channels] unified-channel error: ${String(err)}\n`);
    });
  }

  public async send(message: OutboundMessage): Promise<ReturnType<typeof createChannelMessageId>> {
    if (!this.manager) {
      await this.start();
    }

    const channelName = message.address.channel;
    const chatId = message.address.conversationId || this.getDefaultTarget(channelName);
    if (!chatId) {
      // No target configured — log to console and return local ID
      process.stderr.write(
        `[channels] No target for channel ${channelName}. Message: ${message.body}\n`,
      );
      return createChannelMessageId(`uc-local-${++this.msgCounter}`);
    }

    // Build buttons from actions
    const buttons: UcButton[][] | undefined =
      message.actions && message.actions.length > 0
        ? [message.actions.map((a) => ({ label: a.label, callbackData: a.value }))]
        : undefined;

    try {
      await this.manager!.send(
        channelName,
        chatId,
        message.body,
        buttons ? { buttons } : undefined,
      );
    } catch {
      // Channel error — non-fatal, intervention stays pending
      process.stderr.write(`[channels] Failed to send to ${channelName}:${chatId}\n`);
    }

    return createChannelMessageId(`uc-${channelName}-${++this.msgCounter}`);
  }

  public subscribe(handler: (msg: InboundMessage) => void | Promise<void>): () => void {
    this.inboundHandlers.push(handler);
    return () => {
      const i = this.inboundHandlers.indexOf(handler);
      if (i >= 0) this.inboundHandlers.splice(i, 1);
    };
  }

  public async destroy(): Promise<void> {
    await this.manager?.shutdown();
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async buildAdapter(
    adapters: Record<string, new (...args: unknown[]) => unknown>,
    cfg: UnifiedChannelConfig,
  ): Promise<unknown | null> {
    const token = cfg.tokenEnv ? (process.env[cfg.tokenEnv] ?? '') : '';
    const token2 = cfg.token2Env ? (process.env[cfg.token2Env] ?? '') : '';

    if (!token && cfg.kind !== 'imessage') {
      process.stderr.write(
        `[channels] ${cfg.kind}: no token (${cfg.tokenEnv}) — channel skipped\n`,
      );
      return null;
    }

    switch (cfg.kind) {
      case 'telegram': {
        const { TelegramAdapter } = adapters as unknown as {
          TelegramAdapter: new (token: string) => unknown;
        };
        return new TelegramAdapter(token);
      }
      case 'discord': {
        const { DiscordAdapter } = adapters as unknown as {
          DiscordAdapter: new (token: string) => unknown;
        };
        return new DiscordAdapter(token);
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
        return new SlackAdapter(token, token2);
      }
      case 'imessage': {
        const { IMessageAdapter } = adapters as unknown as { IMessageAdapter: new () => unknown };
        return new IMessageAdapter();
      }
      case 'whatsapp': {
        const { WhatsAppAdapter } = adapters as unknown as {
          WhatsAppAdapter: new (webhookUrl: string) => unknown;
        };
        return new WhatsAppAdapter(token);
      }
      default:
        process.stderr.write(`[channels] Unknown channel kind: ${String(cfg.kind)}\n`);
        return null;
    }
  }

  private getDefaultTarget(channelKind: string): string {
    return this.options.channels.find((c) => c.kind === channelKind)?.defaultTarget ?? '';
  }
}
