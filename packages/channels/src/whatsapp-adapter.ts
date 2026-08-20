/**
 * WhatsApp channel adapter (whatsapp-web.js).
 *
 * Own implementation because `unified-channel`'s WhatsApp adapter assumes
 * `LocalAuth` is an ESM named export of `whatsapp-web.js`, but that CommonJS
 * package only exposes it on the default export under Node's CJS/ESM interop —
 * causing `LocalAuth is not a constructor`. We resolve it from both shapes and
 * render the WhatsApp Web QR code directly to the terminal so a human can scan
 * it during pairing.
 *
 * Because Dark Kitchen links the *user's* own WhatsApp account, outbound
 * notifications land in the "Message yourself" chat. whatsapp-web.js does not
 * emit `message`/`message_create` events for that chat, so replies there would
 * never be seen. To handle this (the most common case) we poll the self-chat
 * for new messages on a short interval and feed them through the same inbound
 * pipeline, deduplicated against the event stream and our own echoes.
 */

interface UcUnifiedMessage {
  id: string;
  channel: string;
  sender: { id: string; username?: string; displayName?: string };
  content: { type: string; text: string; callbackData?: string };
  timestamp: Date;
  chatId?: string;
}

interface UcOutboundMessage {
  chatId: string;
  text: string;
  replyToId?: string;
}

export interface WhatsAppAdapterOptions {
  readonly authStrategy?: 'local' | 'none';
  readonly commandPrefix?: string;
  readonly pollIntervalMs?: number;
  /** Chat to poll for replies (defaults to the account's own JID). */
  readonly selfChatId?: string;
}

// Minimal typing for whatsapp-web.js (no official types shipped).
type WwjClient = {
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  info?: { wid?: { _serialized?: string; user?: string } };
  sendMessage(chatId: string, text: string): Promise<{ id?: { _serialized?: string } }>;
  getChatById(
    chatId: string,
  ): Promise<{ fetchMessages(o?: { limit?: number }): Promise<WwjMessage[]> } | undefined>;
  on(event: 'qr', cb: (qr: string) => void): void;
  on(event: 'ready', cb: () => void): void;
  on(event: 'message', cb: (m: WwjMessage) => void): void;
  on(event: 'message_create', cb: (m: WwjMessage) => void): void;
};

type WwjMessage = {
  id: { _serialized: string; fromMe?: boolean };
  body: string;
  from: string;
  to?: string;
  fromMe?: boolean;
  hasMedia: boolean;
  type: string;
  timestamp: number;
  _data?: { notifyName?: string; quotedStanzaID?: string };
};

type WwjClientConstructor = new (options: { authStrategy?: unknown }) => WwjClient;
type WwjLocalAuthConstructor = new () => unknown;
interface WwjModule {
  readonly Client?: WwjClientConstructor;
  readonly LocalAuth?: WwjLocalAuthConstructor;
  readonly default?: {
    readonly Client?: WwjClientConstructor;
    readonly LocalAuth?: WwjLocalAuthConstructor;
  };
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const ECHO_WINDOW_MS = 15_000;
const SEEN_IDS_MAX = 2_000;

export class WhatsAppAdapter {
  public readonly channelId = 'whatsapp';
  private readonly options: WhatsAppAdapterOptions;
  private connected = false;
  private lastActivity?: Date;
  private client?: WwjClient;
  private handler?: (msg: UcUnifiedMessage) => void | Promise<void>;
  private phoneNumber: string | undefined = undefined;
  /** Recently sent message bodies → timestamp(ms), used to suppress our own echoes. */
  private readonly recentlySent = new Map<string, number>();
  /** The user's own JID (the "Message yourself" chat) — polled for replies. */
  private selfChatId: string | undefined;
  private lastSeenTs = 0;
  private pollTimer: NodeJS.Timeout | undefined = undefined;
  private readonly seenMessageIds = new Set<string>();

  public constructor(options: WhatsAppAdapterOptions = {}) {
    this.options = { ...options, commandPrefix: options.commandPrefix ?? '/' };
  }

  public async connect(): Promise<void> {
    const wwj = (await import('whatsapp-web.js').catch((error: unknown) => {
      throw new Error(
        'WhatsApp support is optional. Install whatsapp-web.js@1.34.7 in the project that runs Dark Kitchen before enabling a whatsapp channel.',
        { cause: error },
      );
    })) as unknown as WwjModule;
    const Client = wwj.Client ?? wwj.default?.Client;
    const LocalAuth = wwj.LocalAuth ?? wwj.default?.LocalAuth;
    if (!Client) {
      throw new Error('The installed whatsapp-web.js package has an incompatible export shape');
    }
    let authStrategy: unknown;
    if (this.options.authStrategy !== 'none') {
      if (!LocalAuth) {
        throw new Error('The installed whatsapp-web.js package has an incompatible export shape');
      }
      authStrategy = new LocalAuth();
    }

    this.client = new Client({ authStrategy }) as WwjClient;

    this.client.on('qr', (qr: string) => {
      this.renderQr(qr);
    });
    this.client.on('ready', () => {
      this.connected = true;
      process.stderr.write('[channels] whatsapp: connected\n');
    });
    // Real-time events for normal (non-self) chats.
    this.client.on('message_create', (message: WwjMessage) => {
      void this.ingestMessage(message).catch((error: unknown) => {
        process.stderr.write(`[channels] whatsapp: inbound handler failed: ${safeError(error)}\n`);
      });
    });

    await this.client.initialize();
    this.phoneNumber = this.client.info?.wid?.user;
    this.selfChatId = this.options.selfChatId ?? this.client.info?.wid?._serialized;
    this.lastSeenTs = Date.now();
    this.startPolling();
  }

  public async disconnect(): Promise<void> {
    this.stopPolling();
    await this.client?.destroy();
    this.connected = false;
  }

  public onMessage(handler: (msg: UcUnifiedMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  public async send(msg: UcOutboundMessage): Promise<string | undefined> {
    this.recentlySent.set(msg.text, Date.now());
    this.pruneRecentlySent();
    const sent = await this.client?.sendMessage(msg.chatId, msg.text);
    this.lastActivity = new Date();
    return sent?.id?._serialized;
  }

  public async getStatus(): Promise<{ connected: boolean; channel: string; accountId?: string }> {
    return {
      connected: this.connected,
      channel: 'whatsapp',
      ...(this.phoneNumber ? { accountId: this.phoneNumber } : {}),
    };
  }

  // ─── Reply polling (self-chat) ─────────────────────────────────────────────

  private startPolling(): void {
    this.stopPolling();
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimer = setInterval(() => {
      void this.pollSelfChat();
    }, interval);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollSelfChat(): Promise<void> {
    if (!this.client || !this.selfChatId) return;
    try {
      const chat = await this.client.getChatById(this.selfChatId);
      if (!chat) return;
      const messages = await chat.fetchMessages({ limit: 15 });
      for (const message of messages) {
        await this.ingestMessage(message);
      }
    } catch {
      // Transient polling failure — retry on the next tick.
    }
  }

  private async ingestMessage(message: WwjMessage): Promise<void> {
    const text = message.body || '';
    const ts = message.timestamp * 1000;
    const id = message.id?._serialized ?? `${message.from}-${message.timestamp}`;

    // Deduplicate across the event stream and polling.
    if (this.seenMessageIds.has(id)) return;
    this.seenMessageIds.add(id);
    if (this.seenMessageIds.size > SEEN_IDS_MAX) {
      for (const k of this.seenMessageIds) {
        this.seenMessageIds.delete(k);
        if (this.seenMessageIds.size <= SEEN_IDS_MAX / 2) break;
      }
    }

    // Suppress echoes of messages Dark Kitchen just sent.
    const sentAt = this.recentlySent.get(text);
    if (sentAt !== undefined && Math.abs(ts - sentAt) < ECHO_WINDOW_MS) {
      this.recentlySent.delete(text);
      return;
    }

    // Ignore messages older than our connection (avoid replaying history).
    if (ts <= this.lastSeenTs) return;
    this.lastSeenTs = ts;

    if (!this.handler) return;
    const prefix = this.options.commandPrefix ?? '/';
    const isCmd = text.startsWith(prefix);
    const parts = isCmd ? text.slice(prefix.length).split(/\s+/) : [];
    this.lastActivity = new Date();
    await this.handler({
      id,
      channel: 'whatsapp',
      sender: {
        id: message.from,
        ...(message._data?.notifyName ? { displayName: message._data.notifyName } : {}),
      },
      content: isCmd
        ? { type: 'command', text, ...(parts[0] ? { callbackData: parts[0] } : {}) }
        : message.hasMedia
          ? { type: 'media', text }
          : { type: 'text', text },
      timestamp: new Date(ts),
      chatId: message.from,
    });
  }

  private pruneRecentlySent(): void {
    const cutoff = Date.now() - 60_000;
    for (const [body, ts] of this.recentlySent) {
      if (ts < cutoff) this.recentlySent.delete(body);
    }
  }

  private async renderQr(qr: string): Promise<void> {
    process.stderr.write('[channels] whatsapp: scan this QR code with WhatsApp:\n');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import('qrcode')) as any;
      const QRCode = mod.default ?? mod;
      const rendered = await QRCode.toString(qr, {
        type: 'utf8',
        errorCorrectionLevel: 'M',
        small: true,
      });
      process.stdout.write(`\n${rendered}\n`);
    } catch {
      process.stdout.write(`[channels] whatsapp QR (raw): ${qr}\n`);
    }
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? 'unknown error'))
    .replace(/((?:bearer|token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/giu, '$1[REDACTED]')
    .slice(0, 500);
}
