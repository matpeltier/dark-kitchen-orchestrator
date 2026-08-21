/**
 * Channel Gateway abstraction for bidirectional human communication.
 *
 * Decouples Dark Kitchen from specific channel implementations (OpenClaw,
 * Slack webhook, direct HTTP). Correlates outbound intervention notifications
 * with inbound human replies and routes responses to the correct intervention.
 */

import type {
  ChannelCorrelationStore,
  ChannelInboundReceipt,
  ChannelMessageCorrelation,
  ChannelMessageId,
  InterventionId,
} from '@dark-kitchen/core';
import { createChannelMessageId } from '@dark-kitchen/core';

// ─── Channel contracts ────────────────────────────────────────────────────────

export interface ChannelAddress {
  readonly channel: string;
  readonly conversationId: string;
}

export interface OutboundMessage {
  readonly address: ChannelAddress;
  readonly body: string;
  readonly actions?: readonly MessageAction[];
  /** Dark Kitchen intervention this message is tied to. */
  readonly interventionId?: InterventionId;
}

export interface MessageAction {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface InboundMessage {
  readonly id: ChannelMessageId;
  readonly address: ChannelAddress;
  readonly body: string;
  readonly actionValue?: string;
  readonly senderId?: string;
  readonly receivedAt: string;
  /** ID of the outbound message this reply quotes (e.g. Telegram reply_to_message_id). */
  readonly replyToMessageId?: string;
}

export type InboundMessageHandler = (message: InboundMessage) => void | Promise<void>;

/** Abstraction over a channel transport (OpenClaw, Slack, webhook, etc.). */
export interface ChannelTransport {
  readonly id: string;
  send(message: OutboundMessage): Promise<ChannelMessageId>;
  subscribe(handler: InboundMessageHandler): () => void;
}

// ─── Correlation store ────────────────────────────────────────────────────────

export type MessageCorrelation = ChannelMessageCorrelation;

/**
 * Short, human-friendly unique code for an intervention (used in notifications
 * and reply routing). When several agents ask in parallel, the human quotes this
 * code to disambiguate which question they are answering.
 */
export function interventionCode(interventionId: InterventionId): string {
  // FNV-1a over the complete stable ID. Using the whole ID avoids the very
  // common collision where generated intervention IDs share an 8-char suffix.
  let hash = 0x811c9dc5;
  for (const char of interventionId) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `DK-${(hash >>> 0).toString(36).toUpperCase().padStart(7, '0')}`;
}

/** In-memory correlation store. */
export class InMemoryCorrelationStore implements ChannelCorrelationStore {
  private readonly byMessageId = new Map<string, MessageCorrelation>();
  private readonly processedInbound = new Set<string>();

  public async saveChannelMessageCorrelation(correlation: MessageCorrelation): Promise<void> {
    this.byMessageId.set(
      correlationKey(correlation.transportId, correlation.address, correlation.messageId),
      correlation,
    );
  }

  public async getActiveChannelMessageCorrelation(
    transportId: string,
    address: ChannelAddress,
    messageId: ChannelMessageId,
  ): Promise<MessageCorrelation | undefined> {
    const correlation = this.byMessageId.get(correlationKey(transportId, address, messageId));
    return correlation?.active ? correlation : undefined;
  }

  public async listActiveChannelMessageCorrelations(options?: {
    readonly transportId?: string;
    readonly address?: ChannelAddress;
    readonly interventionId?: InterventionId;
    readonly code?: string;
  }): Promise<MessageCorrelation[]> {
    return [...this.byMessageId.values()].filter(
      (correlation) =>
        correlation.active &&
        (!options?.transportId || correlation.transportId === options.transportId) &&
        (!options?.address || sameAddress(correlation.address, options.address)) &&
        (!options?.interventionId || correlation.interventionId === options.interventionId) &&
        (!options?.code || correlation.code.toLowerCase() === options.code.trim().toLowerCase()),
    );
  }

  public async deactivateChannelMessageCorrelations(interventionId: InterventionId): Promise<void> {
    for (const [key, correlation] of this.byMessageId) {
      if (correlation.interventionId === interventionId && correlation.active) {
        this.byMessageId.set(key, { ...correlation, active: false });
      }
    }
  }

  public async hasProcessedChannelInbound(
    receipt: Omit<ChannelInboundReceipt, 'processedAt'>,
  ): Promise<boolean> {
    return this.processedInbound.has(
      correlationKey(receipt.transportId, receipt.address, receipt.messageId),
    );
  }

  public async saveProcessedChannelInbound(receipt: ChannelInboundReceipt): Promise<void> {
    this.processedInbound.add(
      correlationKey(receipt.transportId, receipt.address, receipt.messageId),
    );
  }
}

// ─── Channel Gateway ──────────────────────────────────────────────────────────

export type InterventionReplyHandler = (
  interventionId: InterventionId,
  reply: {
    body: string;
    actionValue?: string;
    senderId?: string;
    /** Conversation the human replied from. */
    address: ChannelAddress;
    transportId: string;
  },
) => void | Promise<void>;

export type UnmatchedMessageHandler = (
  message: InboundMessage,
  transportId: string,
) => void | Promise<void>;

export interface ChannelGatewayOptions {
  /** Durable correlation store. Defaults to an isolated in-memory store. */
  readonly correlationStore?: ChannelCorrelationStore;
  /** Bounded retry count after the initial delivery attempt. */
  readonly maxDeliveryRetries?: number;
  readonly retryDelayMs?: number;
  /** Reject oversized untrusted inbound payloads before they reach the runtime. */
  readonly maxInboundBodyLength?: number;
  readonly maxRememberedInboundMessages?: number;
  readonly authorizeInbound?: (
    transportId: string,
    message: InboundMessage,
  ) => boolean | Promise<boolean>;
}

export interface NotificationDelivery {
  readonly transportId: string;
  readonly delivered: boolean;
  readonly attempts: number;
  readonly messageId?: ChannelMessageId;
  readonly error?: string;
}

export interface NotificationReport {
  readonly deliveries: readonly NotificationDelivery[];
  readonly delivered: boolean;
}

/**
 * Manages channel transports, routes outbound intervention notifications, and
 * correlates inbound replies with pending interventions.
 */
export class ChannelGateway {
  private readonly transports = new Map<string, ChannelTransport>();
  private readonly correlations: ChannelCorrelationStore;
  private readonly replyHandlers: InterventionReplyHandler[] = [];
  private readonly unmatchedHandlers: UnmatchedMessageHandler[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private readonly options: Required<
    Pick<
      ChannelGatewayOptions,
      | 'maxDeliveryRetries'
      | 'retryDelayMs'
      | 'maxInboundBodyLength'
      | 'maxRememberedInboundMessages'
    >
  > &
    Pick<ChannelGatewayOptions, 'authorizeInbound'>;
  private readonly seenInbound = new Set<string>();
  private readonly processingInbound = new Set<string>();
  private readonly inFlightNotifications = new Map<string, Promise<NotificationDelivery>>();
  private readonly completedDeliveries = new Map<string, NotificationDelivery>();

  public constructor(options: ChannelGatewayOptions = {}) {
    this.correlations = options.correlationStore ?? new InMemoryCorrelationStore();
    this.options = {
      maxDeliveryRetries: options.maxDeliveryRetries ?? 2,
      retryDelayMs: options.retryDelayMs ?? 250,
      maxInboundBodyLength: options.maxInboundBodyLength ?? 64 * 1024,
      maxRememberedInboundMessages: options.maxRememberedInboundMessages ?? 10_000,
      ...(options.authorizeInbound ? { authorizeInbound: options.authorizeInbound } : {}),
    };
    if (!Number.isInteger(this.options.maxDeliveryRetries) || this.options.maxDeliveryRetries < 0) {
      throw new Error('maxDeliveryRetries must be a non-negative integer');
    }
    if (!Number.isFinite(this.options.retryDelayMs) || this.options.retryDelayMs < 0) {
      throw new Error('retryDelayMs must be a non-negative finite number');
    }
  }

  /** Register a channel transport. */
  public addTransport(transport: ChannelTransport): void {
    if (this.transports.has(transport.id)) {
      throw new Error(`Transport "${transport.id}" is already registered`);
    }
    this.transports.set(transport.id, transport);

    const unsub = transport.subscribe(async (message) => {
      await this.handleInbound(transport.id, message);
    });
    this.unsubscribers.push(unsub);
  }

  /**
   * Send a notification to all configured transports (or a specific one).
   * If the message is tied to an intervention, stores the correlation.
   */
  public async notify(
    message: OutboundMessage,
    transportId?: string,
    options?: { readonly replay?: boolean },
  ): Promise<NotificationReport> {
    const targets = transportId
      ? ([this.transports.get(transportId)].filter(Boolean) as ChannelTransport[])
      : [...this.transports.values()];

    const deliveries = await Promise.all(
      targets.map((transport) => this.deliverToTransport(transport, message, options?.replay)),
    );
    return { deliveries, delivered: deliveries.some((delivery) => delivery.delivered) };
  }

  /** Subscribe to intervention replies routed from inbound channel messages. */
  public onInterventionReply(handler: InterventionReplyHandler): () => void {
    this.replyHandlers.push(handler);
    return () => {
      const idx = this.replyHandlers.indexOf(handler);
      if (idx >= 0) this.replyHandlers.splice(idx, 1);
    };
  }

  /**
   * Subscribe to inbound messages that did not resolve to any pending
   * intervention (free-form chat). Handlers run only after the standard
   * inbound validation and authorization hooks.
   */
  public onUnmatchedMessage(handler: UnmatchedMessageHandler): () => void {
    this.unmatchedHandlers.push(handler);
    return () => {
      const idx = this.unmatchedHandlers.indexOf(handler);
      if (idx >= 0) this.unmatchedHandlers.splice(idx, 1);
    };
  }

  public destroy(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }

  private async handleInbound(transportId: string, message: InboundMessage): Promise<void> {
    if (!(await this.isValidInbound(transportId, message))) return;

    const replayKey = `${transportId}\u0000${message.address.channel}\u0000${message.address.conversationId}\u0000${message.id}`;
    const receipt = {
      transportId,
      address: message.address,
      messageId: message.id,
    };
    if (
      this.seenInbound.has(replayKey) ||
      this.processingInbound.has(replayKey) ||
      (await this.correlations.hasProcessedChannelInbound(receipt))
    ) {
      return;
    }
    this.processingInbound.add(replayKey);

    const resolution = await this.resolveIntervention(transportId, message);
    const interventionId = resolution?.interventionId;
    if (!interventionId) {
      await this.dispatchUnmatched(transportId, message, receipt, replayKey);
      return;
    }
    if (this.replyHandlers.length === 0) {
      this.processingInbound.delete(replayKey);
      return;
    }

    try {
      for (const handler of this.replyHandlers) {
        const reply: Parameters<InterventionReplyHandler>[1] = {
          body: resolution.body,
          address: message.address,
          transportId,
        };
        if (message.actionValue) Object.assign(reply, { actionValue: message.actionValue });
        if (message.senderId) Object.assign(reply, { senderId: message.senderId });
        await handler(interventionId, reply);
      }
      // A human reply is single-use. Deactivating all of the intervention's
      // correlations prevents a later free-form chat message from resolving it
      // again, even if a provider redelivers the update with a different ID.
      await this.correlations.deactivateChannelMessageCorrelations(interventionId);
      await this.correlations.saveProcessedChannelInbound({
        ...receipt,
        processedAt: new Date().toISOString(),
      });
      this.rememberInbound(replayKey);
    } catch {
      // Keep the correlation active so a delivery whose handler failed before
      // committing runtime state can be retried, including with the same ID.
    } finally {
      this.processingInbound.delete(replayKey);
    }
  }

  private async dispatchUnmatched(
    transportId: string,
    message: InboundMessage,
    receipt: { transportId: string; address: ChannelAddress; messageId: ChannelMessageId },
    replayKey: string,
  ): Promise<void> {
    if (this.unmatchedHandlers.length === 0) {
      this.processingInbound.delete(replayKey);
      return;
    }
    try {
      for (const handler of this.unmatchedHandlers) await handler(message, transportId);
      await this.correlations.saveProcessedChannelInbound({
        ...receipt,
        processedAt: new Date().toISOString(),
      });
      this.rememberInbound(replayKey);
    } catch {
      // Keep the message retryable if a handler failed before committing.
    } finally {
      this.processingInbound.delete(replayKey);
    }
  }

  /**
   * Route an inbound message to the intervention it responds to:
   *   1. the exact notification the message quotes (reply-to),
   *   2. a quoted unique code (when several agents ask in parallel),
   *   3. the most recent intervention for that conversation.
   */
  private async resolveIntervention(
    transportId: string,
    message: InboundMessage,
  ): Promise<{ interventionId: InterventionId; body: string } | undefined> {
    if (message.replyToMessageId) {
      const correlated = await this.correlations.getActiveChannelMessageCorrelation(
        transportId,
        message.address,
        message.replyToMessageId as ChannelMessageId,
      );
      if (correlated) return { interventionId: correlated.interventionId, body: message.body };
    }
    const code = extractInterventionCode(message.body);
    if (code) {
      const byCode = await this.correlations.listActiveChannelMessageCorrelations({
        transportId,
        address: message.address,
        code,
      });
      const interventionIds = new Set(byCode.map((item) => item.interventionId));
      if (interventionIds.size === 1) {
        return {
          interventionId: [...interventionIds][0]!,
          body: stripRoutingCode(message.body, code),
        };
      }
    }
    const fallback = await this.findInterventionForConversation(transportId, message.address);
    return fallback ? { interventionId: fallback, body: message.body } : undefined;
  }

  private async findInterventionForConversation(
    transportId: string,
    address: ChannelAddress,
  ): Promise<InterventionId | undefined> {
    const interventions = new Set(
      (await this.correlations.listActiveChannelMessageCorrelations({ transportId, address })).map(
        (correlation) => correlation.interventionId,
      ),
    );
    // Fallback is safe only when the conversation has one pending question.
    // With concurrent interventions the human must reply-to or quote the code.
    return interventions.size === 1 ? [...interventions][0] : undefined;
  }

  private deliverToTransport(
    transport: ChannelTransport,
    message: OutboundMessage,
    replay = false,
  ): Promise<NotificationDelivery> {
    const key = `${transport.id}\u0000${message.address.channel}\u0000${message.address.conversationId}\u0000${message.interventionId ?? messageFingerprint(message)}`;
    const completed = this.completedDeliveries.get(key);
    if (completed && !replay) return Promise.resolve(completed);
    const current = this.inFlightNotifications.get(key);
    if (current) return current;

    const delivery = this.attemptDelivery(transport, message, replay).finally(() => {
      this.inFlightNotifications.delete(key);
    });
    void delivery.then((result) => {
      if (!result.delivered) return;
      this.completedDeliveries.set(key, result);
      if (this.completedDeliveries.size > 10_000) {
        const oldest = this.completedDeliveries.keys().next().value as string | undefined;
        if (oldest) this.completedDeliveries.delete(oldest);
      }
    });
    this.inFlightNotifications.set(key, delivery);
    return delivery;
  }

  private async attemptDelivery(
    transport: ChannelTransport,
    message: OutboundMessage,
    replay = false,
  ): Promise<NotificationDelivery> {
    if (message.interventionId && !replay) {
      const previous = await this.correlations.listActiveChannelMessageCorrelations({
        transportId: transport.id,
        address: message.address,
        interventionId: message.interventionId,
      });
      const existing = previous.at(-1);
      if (existing) {
        return {
          transportId: transport.id,
          delivered: true,
          attempts: 0,
          messageId: existing.messageId,
        };
      }
    }
    let attempts = 0;
    let lastError: unknown;
    while (attempts <= this.options.maxDeliveryRetries) {
      attempts += 1;
      try {
        const messageId = await transport.send(message);
        if (message.interventionId) {
          await this.correlations.saveChannelMessageCorrelation({
            transportId: transport.id,
            messageId,
            interventionId: message.interventionId,
            code: interventionCode(message.interventionId),
            address: message.address,
            sentAt: new Date().toISOString(),
            active: true,
          });
        }
        return { transportId: transport.id, delivered: true, attempts, messageId };
      } catch (error) {
        lastError = error;
        if (attempts <= this.options.maxDeliveryRetries) {
          await delay(this.options.retryDelayMs * 2 ** (attempts - 1));
        }
      }
    }
    return {
      transportId: transport.id,
      delivered: false,
      attempts,
      error: safeErrorMessage(lastError),
    };
  }

  private async isValidInbound(transportId: string, message: InboundMessage): Promise<boolean> {
    if (
      !message.id ||
      !message.address.channel.trim() ||
      !message.address.conversationId.trim() ||
      (!message.body.trim() && !message.actionValue) ||
      message.body.length > this.options.maxInboundBodyLength ||
      !Number.isFinite(Date.parse(message.receivedAt))
    ) {
      return false;
    }
    return (await this.options.authorizeInbound?.(transportId, message)) ?? true;
  }

  private rememberInbound(key: string): void {
    this.seenInbound.add(key);
    if (this.seenInbound.size <= this.options.maxRememberedInboundMessages) return;
    for (const oldKey of this.seenInbound) {
      this.seenInbound.delete(oldKey);
      if (this.seenInbound.size <= Math.floor(this.options.maxRememberedInboundMessages / 2)) break;
    }
  }
}

function correlationKey(
  transportId: string,
  address: ChannelAddress,
  messageId: ChannelMessageId,
): string {
  return `${transportId}\u0000${address.channel}\u0000${address.conversationId}\u0000${messageId}`;
}

function sameAddress(left: ChannelAddress, right: ChannelAddress): boolean {
  return left.channel === right.channel && left.conversationId === right.conversationId;
}

function extractInterventionCode(body: string): string | undefined {
  return /\bDK-[0-9A-Z]{7}\b/i.exec(body)?.[0]?.toUpperCase();
}

function stripRoutingCode(body: string, code: string): string {
  const stripped = body
    .replace(new RegExp(`(?:code\\s*[:#-]?\\s*)?${code}`, 'i'), '')
    .replace(/^\s*(?:[-—–:;,]|answer\s*[:=-]?)\s*/i, '')
    .trim();
  return stripped || body;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown channel error');
  return message
    .replace(/((?:bearer|token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .slice(0, 500);
}

function delay(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function messageFingerprint(message: OutboundMessage): string {
  let hash = 0x811c9dc5;
  const value = `${message.body}\u0000${JSON.stringify(message.actions ?? [])}`;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// ─── OpenClaw transport adapter ───────────────────────────────────────────────

export interface OpenClawConfig {
  readonly id: string;
  readonly gatewayUrl: string;
  readonly apiKey?: string;
  readonly defaultConversationId?: string;
}

/**
 * OpenClaw Gateway channel transport adapter.
 * Routes messages through the OpenClaw multi-channel gateway.
 */
export class OpenClawTransport implements ChannelTransport {
  public readonly id: string;
  private readonly config: OpenClawConfig;
  private readonly handlers: InboundMessageHandler[] = [];

  public constructor(config: OpenClawConfig) {
    validateGatewayUrl(config.gatewayUrl, ['http:', 'https:']);
    if (!isLoopbackUrl(config.gatewayUrl) && !config.apiKey) {
      throw new Error('A remote OpenClaw HTTP gateway requires an API key');
    }
    this.config = config;
    this.id = config.id;
  }

  public async send(message: OutboundMessage): Promise<ChannelMessageId> {
    const conversationId = message.address.conversationId || this.config.defaultConversationId;
    if (!conversationId) throw new Error('OpenClaw conversation ID is required');
    const payload = {
      conversationId,
      channel: message.address.channel,
      text: message.body,
      actions: message.actions ?? [],
    };

    const response = await fetch(`${this.config.gatewayUrl.replace(/\/$/, '')}/api/v1/messages`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...(message.interventionId
          ? { 'Idempotency-Key': `dark-kitchen:${message.interventionId}` }
          : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`OpenClaw API error: ${response.status}`);
    }

    const data = (await response.json()) as { id?: string };
    if (!data.id) throw new Error('OpenClaw response did not include a message ID');
    return createChannelMessageId(data.id);
  }

  public subscribe(handler: InboundMessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  /** Simulate receiving an inbound message (for testing). */
  public async receiveMessage(message: InboundMessage): Promise<void> {
    for (const handler of this.handlers) {
      await handler(message);
    }
  }
}

function validateGatewayUrl(rawUrl: string, allowedProtocols: readonly string[]): void {
  const url = new URL(rawUrl);
  if (!allowedProtocols.includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid or credential-bearing channel gateway URL');
  }
  if (!isLoopbackUrl(rawUrl) && (url.protocol === 'http:' || url.protocol === 'ws:')) {
    throw new Error('Remote channel gateways must use TLS');
  }
}

function isLoopbackUrl(rawUrl: string): boolean {
  const hostname = new URL(rawUrl).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

// ─── Fake transport for testing ───────────────────────────────────────────────

export class FakeChannelTransport implements ChannelTransport {
  public readonly id: string;
  public readonly sent: OutboundMessage[] = [];
  private readonly handlers: InboundMessageHandler[] = [];
  private messageCounter = 0;

  public constructor(id: string) {
    this.id = id;
  }

  public async send(message: OutboundMessage): Promise<ChannelMessageId> {
    this.sent.push(message);
    return createChannelMessageId(`fake-msg-${++this.messageCounter}`);
  }

  public subscribe(handler: InboundMessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  public async receiveMessage(message: InboundMessage): Promise<void> {
    for (const handler of this.handlers) {
      await handler(message);
    }
  }
}
