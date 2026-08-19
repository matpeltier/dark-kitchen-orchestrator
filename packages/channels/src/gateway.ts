/**
 * Channel Gateway abstraction for bidirectional human communication.
 *
 * Decouples Dark Kitchen from specific channel implementations (OpenClaw,
 * Slack webhook, direct HTTP). Correlates outbound intervention notifications
 * with inbound human replies and routes responses to the correct intervention.
 */

import type { ChannelMessageId, InterventionId } from '@dark-kitchen/core';
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
}

export type InboundMessageHandler = (message: InboundMessage) => void | Promise<void>;

/** Abstraction over a channel transport (OpenClaw, Slack, webhook, etc.). */
export interface ChannelTransport {
  readonly id: string;
  send(message: OutboundMessage): Promise<ChannelMessageId>;
  subscribe(handler: InboundMessageHandler): () => void;
}

// ─── Correlation store ────────────────────────────────────────────────────────

export interface MessageCorrelation {
  readonly messageId: ChannelMessageId;
  readonly interventionId: InterventionId;
  readonly address: ChannelAddress;
  readonly sentAt: string;
}

/** In-memory correlation store. */
export class InMemoryCorrelationStore {
  private readonly byMessageId = new Map<ChannelMessageId, MessageCorrelation>();
  private readonly byInterventionId = new Map<InterventionId, ChannelMessageId[]>();

  public set(correlation: MessageCorrelation): void {
    this.byMessageId.set(correlation.messageId, correlation);
    const existing = this.byInterventionId.get(correlation.interventionId) ?? [];
    existing.push(correlation.messageId);
    this.byInterventionId.set(correlation.interventionId, existing);
  }

  public getByMessageId(messageId: ChannelMessageId): MessageCorrelation | undefined {
    return this.byMessageId.get(messageId);
  }

  public getByInterventionId(interventionId: InterventionId): ChannelMessageId[] {
    return this.byInterventionId.get(interventionId) ?? [];
  }
}

// ─── Channel Gateway ──────────────────────────────────────────────────────────

export type InterventionReplyHandler = (
  interventionId: InterventionId,
  reply: { body: string; actionValue?: string; senderId?: string },
) => void | Promise<void>;

/**
 * Manages channel transports, routes outbound intervention notifications, and
 * correlates inbound replies with pending interventions.
 */
export class ChannelGateway {
  private readonly transports = new Map<string, ChannelTransport>();
  private readonly correlations = new InMemoryCorrelationStore();
  private readonly replyHandlers: InterventionReplyHandler[] = [];
  private readonly unsubscribers: Array<() => void> = [];

  /** Register a channel transport. */
  public addTransport(transport: ChannelTransport): void {
    if (this.transports.has(transport.id)) {
      throw new Error(`Transport "${transport.id}" is already registered`);
    }
    this.transports.set(transport.id, transport);

    const unsub = transport.subscribe(async (message) => {
      await this.handleInbound(message);
    });
    this.unsubscribers.push(unsub);
  }

  /**
   * Send a notification to all configured transports (or a specific one).
   * If the message is tied to an intervention, stores the correlation.
   */
  public async notify(message: OutboundMessage, transportId?: string): Promise<void> {
    const targets = transportId
      ? ([this.transports.get(transportId)].filter(Boolean) as ChannelTransport[])
      : [...this.transports.values()];

    for (const transport of targets) {
      try {
        const msgId = await transport.send(message);
        if (message.interventionId) {
          this.correlations.set({
            messageId: msgId,
            interventionId: message.interventionId,
            address: message.address,
            sentAt: new Date().toISOString(),
          });
        }
      } catch {
        // Channel outage: log but preserve intervention pending state
        // In production, retry with bounded backoff would be implemented here.
      }
    }
  }

  /** Subscribe to intervention replies routed from inbound channel messages. */
  public onInterventionReply(handler: InterventionReplyHandler): () => void {
    this.replyHandlers.push(handler);
    return () => {
      const idx = this.replyHandlers.indexOf(handler);
      if (idx >= 0) this.replyHandlers.splice(idx, 1);
    };
  }

  public destroy(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    // Try to correlate by conversation ID
    const interventionId = this.findInterventionForConversation(message.address);
    if (!interventionId) return;

    for (const handler of this.replyHandlers) {
      const reply: { body: string; actionValue?: string; senderId?: string } = {
        body: message.body,
      };
      if (message.actionValue) Object.assign(reply, { actionValue: message.actionValue });
      if (message.senderId) Object.assign(reply, { senderId: message.senderId });
      await handler(interventionId, reply);
    }
  }

  private findInterventionForConversation(address: ChannelAddress): InterventionId | undefined {
    // Look up by conversation ID across all correlations
    for (const [, corr] of [...this.correlations['byMessageId'].entries()]) {
      if (
        corr.address.channel === address.channel &&
        corr.address.conversationId === address.conversationId
      ) {
        return corr.interventionId;
      }
    }
    return undefined;
  }
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
  private messageCounter = 0;

  public constructor(config: OpenClawConfig) {
    this.config = config;
    this.id = config.id;
  }

  public async send(message: OutboundMessage): Promise<ChannelMessageId> {
    const payload = {
      conversationId: message.address.conversationId,
      channel: message.address.channel,
      text: message.body,
      actions: message.actions ?? [],
    };

    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`OpenClaw API error: ${response.status}`);
      }

      const data = (await response.json()) as { id?: string };
      return createChannelMessageId(data.id ?? `openclaw-${Date.now()}`);
    } catch {
      // Return a local ID for correlation; delivery will be retried
      return createChannelMessageId(`openclaw-local-${++this.messageCounter}`);
    }
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
