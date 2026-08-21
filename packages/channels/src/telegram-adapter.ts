/**
 * Hardened Telegram adapter used by UnifiedChannelTransport.
 *
 * The upstream adapter defaults to Markdown parsing (so arbitrary intervention
 * text can make Telegram reject a message), drops pending polling updates on
 * every restart, and accepts webhook POSTs without Telegram's secret header.
 * This adapter sends plain text, preserves pending replies, applies chat/sender
 * allowlists, and requires authenticated webhooks.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { fitChannelMessage } from './unified-channel-transport.js';

interface TelegramUnifiedMessage {
  id: string;
  channel: string;
  sender: { id: string; username?: string; displayName?: string };
  content: { type: string; text: string; callbackData?: string };
  timestamp: Date;
  chatId?: string;
  replyToId?: string;
}

interface TelegramOutboundMessage {
  chatId: string;
  text: string;
  buttons?: Array<Array<{ label: string; callbackData?: string; url?: string }>>;
}

interface TelegramBot {
  readonly api: {
    getMe(): Promise<{ username?: string }>;
    sendMessage(
      chatId: string | number,
      text: string,
      options?: Record<string, unknown>,
    ): Promise<{ message_id: number }>;
    setWebhook(url: string, options?: { secret_token?: string }): Promise<unknown>;
    deleteWebhook(): Promise<unknown>;
  };
  init(): Promise<void>;
  start(options?: { drop_pending_updates?: boolean }): Promise<void>;
  stop(): Promise<void>;
  handleUpdate(update: unknown): Promise<void>;
  on(event: string, handler: (context: TelegramContext) => void | Promise<void>): void;
}

interface TelegramContext {
  readonly from: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  readonly chat?: { id: number };
  readonly message?: {
    message_id: number;
    text?: string;
    date: number;
    reply_to_message?: { message_id: number };
  };
  readonly callbackQuery?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number }; date?: number };
  };
  answerCallbackQuery(): Promise<unknown>;
}

export interface TelegramChannelAdapterOptions {
  readonly mode?: 'polling' | 'webhook';
  readonly allowedChatIds?: readonly string[];
  readonly allowedSenderIds?: readonly string[];
  readonly dropPendingUpdates?: boolean;
  readonly webhookUrl?: string;
  readonly webhookPort?: number;
  readonly webhookPath?: string;
  readonly webhookSecret?: string;
  /** Loopback is the safe default; expose it through an authenticated proxy. */
  readonly webhookHost?: string;
  /** Polling reconnection: base delay for the exponential backoff. */
  readonly reconnectBaseDelayMs?: number;
  /** Polling reconnection: upper bound for a single backoff delay. */
  readonly reconnectMaxDelayMs?: number;
  /** Polling reconnection: give up after this many consecutive failures. */
  readonly maxReconnectAttempts?: number;
}

type TelegramBotFactory = (token: string) => Promise<TelegramBot>;

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

export class TelegramChannelAdapter {
  public readonly channelId = 'telegram';
  private readonly token: string;
  private readonly options: TelegramChannelAdapterOptions;
  private readonly botFactory: TelegramBotFactory;
  private readonly allowedChatIds: ReadonlySet<string>;
  private readonly allowedSenderIds: ReadonlySet<string>;
  private bot: TelegramBot | undefined;
  private handler?: (message: TelegramUnifiedMessage) => void | Promise<void>;
  private server: Server | undefined;
  private connected = false;
  private botUsername: string | undefined;
  private lastActivity: Date | undefined;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    token: string,
    options: TelegramChannelAdapterOptions = {},
    botFactory: TelegramBotFactory = createTelegramBot,
  ) {
    if (!token.trim()) throw new Error('Telegram bot token is required');
    this.token = token;
    this.options = options;
    this.botFactory = botFactory;
    this.allowedChatIds = new Set(options.allowedChatIds ?? []);
    this.allowedSenderIds = new Set(options.allowedSenderIds ?? []);
    if (this.allowedChatIds.size === 0) {
      throw new Error('Telegram requires at least one allowed chat ID');
    }
  }

  public async connect(): Promise<void> {
    if (this.connected) return;
    this.stopped = false;
    const bot = await this.createBot();
    this.bot = bot;

    if ((this.options.mode ?? 'polling') === 'webhook') {
      await this.startWebhook(bot);
    } else {
      this.startPolling(bot);
    }
    this.connected = true;
    this.reconnectAttempts = 0;
  }

  public async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.connected = false;
    this.reconnectAttempts = 0;
    if ((this.options.mode ?? 'polling') === 'webhook') {
      await this.stopWebhook();
    } else {
      await this.bot?.stop().catch(() => undefined);
    }
    this.bot = undefined;
  }

  public onMessage(handler: (message: TelegramUnifiedMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  public async send(message: TelegramOutboundMessage): Promise<string> {
    if (!this.bot || !this.connected) throw new Error('Telegram adapter is not connected');
    if (!message.chatId.trim()) throw new Error('Telegram chat ID is required');
    const body = fitChannelMessage('telegram', message.text);
    if (!body.trim()) throw new Error('Telegram message body is empty');

    const options: Record<string, unknown> = {};
    if (message.buttons && message.buttons.length > 0) {
      options['reply_markup'] = {
        inline_keyboard: message.buttons.map((row) =>
          row.map((button) => {
            if (button.callbackData) validateCallbackData(button.callbackData);
            return {
              text: button.label.slice(0, 64),
              ...(button.callbackData ? { callback_data: button.callbackData } : {}),
              ...(button.url ? { url: button.url } : {}),
            };
          }),
        ),
      };
    }

    const numericChatId = /^-?\d+$/.test(message.chatId) ? Number(message.chatId) : message.chatId;
    const sent = await this.bot.api.sendMessage(numericChatId, body, options);
    this.lastActivity = new Date();
    return String(sent.message_id);
  }

  public async getStatus(): Promise<{
    connected: boolean;
    channel: string;
    accountId?: string;
    lastActivity?: Date;
  }> {
    return {
      connected: this.connected,
      channel: this.channelId,
      ...(this.botUsername ? { accountId: this.botUsername } : {}),
      ...(this.lastActivity ? { lastActivity: this.lastActivity } : {}),
    };
  }

  private async createBot(): Promise<TelegramBot> {
    const bot = await this.botFactory(this.token);
    this.registerHandlers(bot);
    await bot.init();
    this.botUsername = (await bot.api.getMe()).username;
    return bot;
  }

  private startPolling(bot: TelegramBot): void {
    // Pending replies are part of the durable intervention flow. Dropping
    // them after a daemon restart would strand the waiting PM/agent.
    void bot
      .start({ drop_pending_updates: this.options.dropPendingUpdates ?? false })
      .catch((error: unknown) => {
        if (this.stopped) return;
        this.connected = false;
        process.stderr.write(`[channels] telegram polling stopped: ${safeError(error)}\n`);
        this.scheduleReconnect();
      });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.connected || this.reconnectTimer) return;
    const maxAttempts = this.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    if (this.reconnectAttempts >= maxAttempts) {
      process.stderr.write(
        `[channels] telegram reconnection gave up after ${String(maxAttempts)} attempts\n`,
      );
      return;
    }
    const base = this.options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    const max = this.options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const delay = Math.min(base * 2 ** this.reconnectAttempts, max);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || this.connected) return;
    try {
      const bot = await this.createBot();
      this.bot = bot;
      this.startPolling(bot);
      this.connected = true;
      process.stderr.write('[channels] telegram polling reconnected\n');
    } catch (error) {
      this.connected = false;
      process.stderr.write(`[channels] telegram reconnection failed: ${safeError(error)}\n`);
      this.scheduleReconnect();
    }
  }

  private registerHandlers(bot: TelegramBot): void {
    bot.on('message:text', async (context) => {
      const message = context.message;
      const chatId = context.chat ? String(context.chat.id) : '';
      if (!message?.text || !this.isAllowed(chatId, String(context.from.id))) return;
      await this.emit({
        id: String(message.message_id),
        channel: this.channelId,
        sender: senderFromContext(context),
        content: { type: 'text', text: message.text },
        timestamp: new Date(message.date * 1000),
        chatId,
        ...(message.reply_to_message
          ? { replyToId: String(message.reply_to_message.message_id) }
          : {}),
      });
    });

    bot.on('callback_query:data', async (context) => {
      const callback = context.callbackQuery;
      const chatId = callback?.message ? String(callback.message.chat.id) : '';
      const data = callback?.data;
      if (!callback || !data || !this.isAllowed(chatId, String(context.from.id))) return;
      await context.answerCallbackQuery().catch(() => undefined);
      await this.emit({
        id: callback.id,
        channel: this.channelId,
        sender: senderFromContext(context),
        content: { type: 'callback', text: data, callbackData: data },
        timestamp: new Date((callback.message?.date ?? Math.floor(Date.now() / 1000)) * 1000),
        chatId,
        // The callback is attached to the outbound intervention message.
        ...(callback.message ? { replyToId: String(callback.message.message_id) } : {}),
      });
    });
  }

  private isAllowed(chatId: string, senderId: string): boolean {
    return (
      this.allowedChatIds.has(chatId) &&
      (this.allowedSenderIds.size === 0 || this.allowedSenderIds.has(senderId))
    );
  }

  private async emit(message: TelegramUnifiedMessage): Promise<void> {
    this.lastActivity = new Date();
    await this.handler?.(message);
  }

  private async startWebhook(bot: TelegramBot): Promise<void> {
    const webhookUrl = this.options.webhookUrl;
    const secret = this.options.webhookSecret;
    if (!webhookUrl || new URL(webhookUrl).protocol !== 'https:') {
      throw new Error('Telegram webhookUrl must be an HTTPS URL');
    }
    if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
      throw new Error('Telegram webhookSecret is required and has an invalid format');
    }
    const port = this.options.webhookPort ?? 8443;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Telegram webhookPort must be between 1 and 65535');
    }
    const path = this.options.webhookPath ?? '/telegram-webhook';
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path)) throw new Error('Invalid Telegram webhook path');

    const publicUrl = new URL(path, webhookUrl).toString();
    await bot.api.setWebhook(publicUrl, { secret_token: secret });
    this.server = createServer((request, response) => {
      void this.handleWebhookRequest(request, response, bot, path, secret);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(port, this.options.webhookHost ?? '127.0.0.1', () => {
          this.server!.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      await bot.api.deleteWebhook().catch(() => undefined);
      throw error;
    }
  }

  private async handleWebhookRequest(
    request: IncomingMessage,
    response: ServerResponse,
    bot: TelegramBot,
    path: string,
    secret: string,
  ): Promise<void> {
    if (
      request.method !== 'POST' ||
      request.url !== path ||
      !safeSecretEquals(request.headers['x-telegram-bot-api-secret-token'], secret)
    ) {
      request.resume();
      response.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.byteLength;
        if (size > MAX_WEBHOOK_BODY_BYTES) {
          response.writeHead(413).end();
          request.destroy();
          return;
        }
        chunks.push(buffer);
      }
      const update = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      await bot.handleUpdate(update);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    } catch {
      response.writeHead(400).end('Bad Request');
    }
  }

  private async stopWebhook(): Promise<void> {
    await this.bot?.api.deleteWebhook().catch(() => undefined);
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function createTelegramBot(token: string): Promise<TelegramBot> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grammy = (await import('grammy')) as any;
  return new grammy.Bot(token) as TelegramBot;
}

function senderFromContext(context: TelegramContext): TelegramUnifiedMessage['sender'] {
  const displayName = [context.from.first_name, context.from.last_name].filter(Boolean).join(' ');
  return {
    id: String(context.from.id),
    ...(context.from.username ? { username: context.from.username } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function validateCallbackData(value: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > 64) throw new Error('Telegram callback data must be 1-64 UTF-8 bytes');
}

function safeSecretEquals(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== 'string') return false;
  const received = Buffer.from(header);
  const wanted = Buffer.from(expected);
  return received.byteLength === wanted.byteLength && timingSafeEqual(received, wanted);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? 'unknown error'))
    .replace(/((?:bearer|token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .slice(0, 500);
}
