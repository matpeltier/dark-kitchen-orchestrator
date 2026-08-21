import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRuntimeStore } from '@dark-kitchen/runtime-store-sqlite';
import {
  ChannelGateway,
  FakeChannelTransport,
  fitChannelMessage,
  interventionCode,
  OpenClawGatewayTransport,
  OpenClawTransport,
} from './index.js';
import { createChannelMessageId, createInterventionId } from '@dark-kitchen/core';

describe('ChannelGateway', () => {
  it('sends to all registered transports', async () => {
    const t1 = new FakeChannelTransport('t1');
    const t2 = new FakeChannelTransport('t2');
    const gateway = new ChannelGateway();
    gateway.addTransport(t1);
    gateway.addTransport(t2);

    await gateway.notify({
      address: { channel: 't1', conversationId: 'conv-1' },
      body: 'Hello',
    });

    expect(t1.sent).toHaveLength(1);
    expect(t2.sent).toHaveLength(1);
    gateway.destroy();
  });

  it('routes inbound reply to the correct intervention', async () => {
    const transport = new FakeChannelTransport('test-ch');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);

    const interventionId = createInterventionId('int-1');
    const replies: string[] = [];

    gateway.onInterventionReply((_id, reply) => {
      replies.push(reply.body);
    });

    // Send an outbound message correlated with an intervention
    await gateway.notify({
      address: { channel: 'test-ch', conversationId: 'conv-2' },
      body: 'Do you approve?',
      interventionId,
    });

    // Simulate an inbound reply
    await transport.receiveMessage({
      id: createChannelMessageId('msg-1'),
      address: { channel: 'test-ch', conversationId: 'conv-2' },
      body: 'Yes, approved',
      receivedAt: new Date().toISOString(),
    });

    expect(replies).toContain('Yes, approved');
    gateway.destroy();
  });

  it('does not route reply without prior correlation', async () => {
    const transport = new FakeChannelTransport('unrelated');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);

    const replies: string[] = [];
    gateway.onInterventionReply((_, reply) => {
      replies.push(reply.body);
    });

    await transport.receiveMessage({
      id: createChannelMessageId('msg-x'),
      address: { channel: 'unrelated', conversationId: 'unknown-conv' },
      body: 'Random message',
      receivedAt: new Date().toISOString(),
    });

    expect(replies).toHaveLength(0);
    gateway.destroy();
  });

  it('handles provider replay idempotently at the channel boundary', async () => {
    const transport = new FakeChannelTransport('dedup-ch');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);

    const interventionId = createInterventionId('int-dedup');
    const replies: string[] = [];
    gateway.onInterventionReply((_, reply) => {
      replies.push(reply.body);
    });

    await gateway.notify({
      address: { channel: 'dedup-ch', conversationId: 'conv-dedup' },
      body: 'Waiting for approval',
      interventionId,
    });

    const inbound = {
      id: createChannelMessageId('msg-dup'),
      address: { channel: 'dedup-ch', conversationId: 'conv-dedup' },
      body: 'Approved',
      receivedAt: new Date().toISOString(),
    };

    // Deliver same message twice (duplicate delivery)
    await transport.receiveMessage(inbound);
    await transport.receiveMessage(inbound);
    expect(replies).toHaveLength(1);
    gateway.destroy();
  });

  it('routes reply-to to the exact intervention quoted (parallel agents)', async () => {
    const transport = new FakeChannelTransport('reply-ch');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);

    const intAlpha = createInterventionId('int-111-a1pha2betagamma');
    const intBeta = createInterventionId('int-222-beetax');
    const routed: string[] = [];

    gateway.onInterventionReply((id, _reply) => {
      routed.push(id);
    });

    await gateway.notify({
      address: { channel: 'reply-ch', conversationId: 'conv-p' },
      body: 'Q from agent A',
      interventionId: intAlpha,
    });
    await gateway.notify({
      address: { channel: 'reply-ch', conversationId: 'conv-p' },
      body: 'Q from agent B',
      interventionId: intBeta,
    });

    // Reply quoting the FIRST message id (agent A) while a newer one exists
    await transport.receiveMessage({
      id: createChannelMessageId('in-reply'),
      address: { channel: 'reply-ch', conversationId: 'conv-p' },
      body: 'navy blue',
      receivedAt: new Date().toISOString(),
      replyToMessageId: 'fake-msg-1',
    });

    expect(routed).toEqual([intAlpha]);
    gateway.destroy();
  });

  it('routes by unique intervention code when no reply-to is present', async () => {
    const transport = new FakeChannelTransport('code-ch');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);

    const intAlpha = createInterventionId('int-111-a1pha2betagamma');
    const intBeta = createInterventionId('int-222-beetax');
    const routed: string[] = [];

    gateway.onInterventionReply((id, _reply) => {
      routed.push(id);
    });

    await gateway.notify({
      address: { channel: 'code-ch', conversationId: 'conv-c' },
      body: 'Q alpha',
      interventionId: intAlpha,
    });
    await gateway.notify({
      address: { channel: 'code-ch', conversationId: 'conv-c' },
      body: 'Q beta',
      interventionId: intBeta,
    });

    // Latest by conversation is intBeta, but quoting alpha's code must target alpha
    await transport.receiveMessage({
      id: createChannelMessageId('in-code'),
      address: { channel: 'code-ch', conversationId: 'conv-c' },
      body: `${interventionCode(intAlpha)} — answer: 42`,
      receivedAt: new Date().toISOString(),
    });

    expect(routed).toEqual([intAlpha]);
    gateway.destroy();
  });

  it('does not guess when two interventions are pending in one conversation', async () => {
    const transport = new FakeChannelTransport('parallel-ch');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);
    const routed: string[] = [];
    gateway.onInterventionReply((id) => {
      routed.push(id);
    });

    await gateway.notify({
      address: { channel: 'parallel-ch', conversationId: 'conv' },
      body: 'one',
      interventionId: createInterventionId('parallel-one'),
    });
    await gateway.notify({
      address: { channel: 'parallel-ch', conversationId: 'conv' },
      body: 'two',
      interventionId: createInterventionId('parallel-two'),
    });
    await transport.receiveMessage({
      id: createChannelMessageId('ambiguous'),
      address: { channel: 'parallel-ch', conversationId: 'conv' },
      body: 'yes',
      receivedAt: new Date().toISOString(),
    });

    expect(routed).toEqual([]);
    gateway.destroy();
  });

  it('scopes reply-to IDs and intervention codes to the same conversation', async () => {
    const transport = new FakeChannelTransport('secure-ch');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);
    const interventionId = createInterventionId('secure-intervention');
    const routed: string[] = [];
    gateway.onInterventionReply((id) => {
      routed.push(id);
    });
    await gateway.notify({
      address: { channel: 'secure-ch', conversationId: 'allowed' },
      body: 'approve?',
      interventionId,
    });

    await transport.receiveMessage({
      id: createChannelMessageId('attack-1'),
      address: { channel: 'secure-ch', conversationId: 'other' },
      body: interventionCode(interventionId),
      replyToMessageId: 'fake-msg-1',
      receivedAt: new Date().toISOString(),
    });
    expect(routed).toEqual([]);
    gateway.destroy();
  });

  it('scopes colliding provider message IDs to their transport', async () => {
    const first = new FakeChannelTransport('bot-one');
    const second = new FakeChannelTransport('bot-two');
    const gateway = new ChannelGateway();
    gateway.addTransport(first);
    gateway.addTransport(second);
    const firstIntervention = createInterventionId('bot-one-intervention');
    const secondIntervention = createInterventionId('bot-two-intervention');
    const routed: string[] = [];
    gateway.onInterventionReply((id) => {
      routed.push(id);
    });
    const address = { channel: 'telegram', conversationId: '42' } as const;
    await gateway.notify({ address, body: 'first?', interventionId: firstIntervention }, 'bot-one');
    await gateway.notify(
      { address, body: 'second?', interventionId: secondIntervention },
      'bot-two',
    );

    await first.receiveMessage({
      id: createChannelMessageId('reply'),
      address,
      body: 'answer',
      replyToMessageId: 'fake-msg-1',
      receivedAt: new Date().toISOString(),
    });
    expect(routed).toEqual([firstIntervention]);
    gateway.destroy();
  });

  it('enforces an inbound authorization hook', async () => {
    const transport = new FakeChannelTransport('auth-ch');
    const gateway = new ChannelGateway({
      authorizeInbound: (_transportId, message) => message.senderId === 'owner',
    });
    gateway.addTransport(transport);
    let replies = 0;
    gateway.onInterventionReply(() => {
      replies += 1;
    });
    await gateway.notify({
      address: { channel: 'auth-ch', conversationId: 'conv' },
      body: 'question',
      interventionId: createInterventionId('auth-int'),
    });

    await transport.receiveMessage({
      id: createChannelMessageId('unauthorized'),
      address: { channel: 'auth-ch', conversationId: 'conv' },
      body: 'approve',
      senderId: 'attacker',
      receivedAt: new Date().toISOString(),
    });
    expect(replies).toBe(0);
    gateway.destroy();
  });

  it('rejects blank, oversized, and invalid-timestamp inbound messages', async () => {
    const transport = new FakeChannelTransport('invalid-ch');
    const gateway = new ChannelGateway({ maxInboundBodyLength: 16 });
    gateway.addTransport(transport);
    let replies = 0;
    gateway.onInterventionReply(() => {
      replies += 1;
    });
    await gateway.notify({
      address: { channel: 'invalid-ch', conversationId: 'conv' },
      body: 'question',
      interventionId: createInterventionId('invalid-int'),
    });

    for (const [id, body, receivedAt] of [
      ['blank', '   ', new Date().toISOString()],
      ['long', 'x'.repeat(17), new Date().toISOString()],
      ['date', 'answer', 'not-a-date'],
    ] as const) {
      await transport.receiveMessage({
        id: createChannelMessageId(id),
        address: { channel: 'invalid-ch', conversationId: 'conv' },
        body,
        receivedAt,
      });
    }
    expect(replies).toBe(0);
    gateway.destroy();
  });

  it('retries delivery with bounded backoff and reports exhaustion', async () => {
    class FlakyTransport extends FakeChannelTransport {
      public attempts = 0;
      public constructor(
        id: string,
        private failuresRemaining: number,
      ) {
        super(id);
      }
      public override async send(message: Parameters<FakeChannelTransport['send']>[0]) {
        this.attempts += 1;
        if (this.failuresRemaining-- > 0) throw new Error('token=must-not-leak');
        return super.send(message);
      }
    }

    const recovered = new FlakyTransport('recover', 2);
    const gateway = new ChannelGateway({ maxDeliveryRetries: 2, retryDelayMs: 0 });
    gateway.addTransport(recovered);
    const report = await gateway.notify({
      address: { channel: 'recover', conversationId: 'conv' },
      body: 'question',
      interventionId: createInterventionId('retry-int'),
    });
    expect(report.delivered).toBe(true);
    expect(report.deliveries[0]?.attempts).toBe(3);

    const failed = new FlakyTransport('failed', 5);
    const failedGateway = new ChannelGateway({ maxDeliveryRetries: 1, retryDelayMs: 0 });
    failedGateway.addTransport(failed);
    const failedReport = await failedGateway.notify({
      address: { channel: 'failed', conversationId: 'conv' },
      body: 'question',
      interventionId: createInterventionId('failed-int'),
    });
    expect(failedReport.delivered).toBe(false);
    expect(failedReport.deliveries[0]?.attempts).toBe(2);
    expect(failedReport.deliveries[0]?.error).not.toContain('must-not-leak');
    gateway.destroy();
    failedGateway.destroy();
  });

  it('coalesces concurrent and replayed notification delivery', async () => {
    const transport = new FakeChannelTransport('notify-dedup');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);
    const outbound = {
      address: { channel: 'notify-dedup', conversationId: 'conv' },
      body: 'question',
      interventionId: createInterventionId('notify-int'),
    } as const;

    await Promise.all([gateway.notify(outbound), gateway.notify(outbound)]);
    await gateway.notify(outbound);
    expect(transport.sent).toHaveLength(1);
    gateway.destroy();
  });

  it('allows same provider event to replay after a handler failure', async () => {
    const transport = new FakeChannelTransport('handler-retry');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);
    let attempts = 0;
    gateway.onInterventionReply(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient store failure');
    });
    await gateway.notify({
      address: { channel: 'handler-retry', conversationId: 'conv' },
      body: 'question',
      interventionId: createInterventionId('handler-int'),
    });
    const reply = {
      id: createChannelMessageId('stable-provider-id'),
      address: { channel: 'handler-retry', conversationId: 'conv' },
      body: 'answer',
      receivedAt: new Date().toISOString(),
    } as const;
    await transport.receiveMessage(reply);
    await transport.receiveMessage(reply);
    expect(attempts).toBe(2);
    gateway.destroy();
  });

  it('fits long provider messages while preserving their beginning and end', () => {
    const body = `begin-${'x'.repeat(5_000)}-end`;
    const fitted = fitChannelMessage('telegram', body);
    expect(fitted.length).toBe(4_096);
    expect(fitted.startsWith('begin-')).toBe(true);
    expect(fitted.endsWith('-end')).toBe(true);
    expect(fitted).toContain('message truncated by Dark Kitchen');
  });

  it('derives codes from the whole intervention ID, not a colliding suffix', () => {
    expect(interventionCode(createInterventionId('first-same-suffix'))).not.toBe(
      interventionCode(createInterventionId('second-same-suffix')),
    );
  });

  it('rejects insecure or credential-bearing remote gateway URLs', () => {
    expect(
      () => new OpenClawTransport({ id: 'http', gatewayUrl: 'http://remote.example' }),
    ).toThrow(/TLS/);
    expect(
      () => new OpenClawTransport({ id: 'https', gatewayUrl: 'https://remote.example' }),
    ).toThrow(/API key/);
    expect(
      () => new OpenClawGatewayTransport({ id: 'ws', gatewayUrl: 'ws://remote.example/socket' }),
    ).toThrow(/TLS/);
    expect(
      () =>
        new OpenClawGatewayTransport({
          id: 'creds',
          gatewayUrl: 'wss://user:password@remote.example/socket',
        }),
    ).toThrow(/credential/);
  });

  it('rejects duplicate transport registration', () => {
    const gateway = new ChannelGateway();
    const t = new FakeChannelTransport('same-id');
    gateway.addTransport(t);
    expect(() => gateway.addTransport(new FakeChannelTransport('same-id'))).toThrow();
    gateway.destroy();
  });

  it('routes unmatched inbound messages to the free-chat handler', async () => {
    const transport = new FakeChannelTransport('free-ch');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);
    const received: Array<{ body: string; senderId?: string }> = [];
    gateway.onUnmatchedMessage((message) => {
      received.push({
        body: message.body,
        ...(message.senderId ? { senderId: message.senderId } : {}),
      });
    });

    await transport.receiveMessage({
      id: createChannelMessageId('free-1'),
      address: { channel: 'free-ch', conversationId: 'conv-free' },
      body: 'hello, what are you working on?',
      senderId: 'owner',
      receivedAt: new Date().toISOString(),
    });

    expect(received).toEqual([{ body: 'hello, what are you working on?', senderId: 'owner' }]);
    gateway.destroy();
  });

  it('delivers each free-chat message only once across provider redelivery', async () => {
    const transport = new FakeChannelTransport('free-dedup');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);
    let count = 0;
    gateway.onUnmatchedMessage(() => {
      count += 1;
    });
    const inbound = {
      id: createChannelMessageId('free-dup'),
      address: { channel: 'free-dedup', conversationId: 'conv' },
      body: 'ping',
      receivedAt: new Date().toISOString(),
    } as const;
    await transport.receiveMessage(inbound);
    await transport.receiveMessage(inbound);
    expect(count).toBe(1);
    gateway.destroy();
  });

  it('applies the inbound authorization hook to free-chat messages (fail-closed)', async () => {
    const transport = new FakeChannelTransport('free-auth');
    const gateway = new ChannelGateway({
      authorizeInbound: (_transportId, message) => message.senderId === 'owner',
    });
    gateway.addTransport(transport);
    let count = 0;
    gateway.onUnmatchedMessage(() => {
      count += 1;
    });
    await transport.receiveMessage({
      id: createChannelMessageId('free-attack'),
      address: { channel: 'free-auth', conversationId: 'conv' },
      body: 'inject',
      senderId: 'attacker',
      receivedAt: new Date().toISOString(),
    });
    expect(count).toBe(0);
    gateway.destroy();
  });

  it('gives intervention replies priority over the free-chat handler', async () => {
    const transport = new FakeChannelTransport('priority-ch');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);
    const routed: string[] = [];
    const freeChat: string[] = [];
    gateway.onInterventionReply((_id, reply) => {
      routed.push(reply.body);
    });
    gateway.onUnmatchedMessage((message) => {
      freeChat.push(message.body);
    });
    await gateway.notify({
      address: { channel: 'priority-ch', conversationId: 'conv-prio' },
      body: 'question',
      interventionId: createInterventionId('prio-int'),
    });
    await transport.receiveMessage({
      id: createChannelMessageId('prio-reply'),
      address: { channel: 'priority-ch', conversationId: 'conv-prio' },
      body: 'the answer',
      receivedAt: new Date().toISOString(),
    });
    expect(routed).toEqual(['the answer']);
    expect(freeChat).toEqual([]);
    gateway.destroy();
  });

  it('exposes the origin address and transport on intervention replies', async () => {
    const transport = new FakeChannelTransport('addr-ch');
    const gateway = new ChannelGateway();
    gateway.addTransport(transport);
    const origins: Array<{ address?: unknown; transportId?: string }> = [];
    gateway.onInterventionReply((_id, reply) => {
      origins.push({ address: reply.address, transportId: reply.transportId });
    });
    await gateway.notify(
      {
        address: { channel: 'addr-ch', conversationId: 'conv-addr' },
        body: 'question',
        interventionId: createInterventionId('addr-int'),
      },
      'addr-ch',
    );
    await transport.receiveMessage({
      id: createChannelMessageId('addr-reply'),
      address: { channel: 'addr-ch', conversationId: 'conv-addr' },
      body: 'answer',
      receivedAt: new Date().toISOString(),
    });
    expect(origins).toEqual([
      { address: { channel: 'addr-ch', conversationId: 'conv-addr' }, transportId: 'addr-ch' },
    ]);
    gateway.destroy();
  });

  it('re-emits a notification past an existing correlation when replay is requested', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dk-channel-replay-'));
    const databasePath = join(directory, 'runtime.db');
    const address = { channel: 'telegram', conversationId: 'chat-replay' } as const;
    const interventionId = createInterventionId('replay-intervention');
    try {
      const store = await SqliteRuntimeStore.open({ databasePath });
      const gateway = new ChannelGateway({ correlationStore: store });
      const transport = new FakeChannelTransport('telegram-main');
      gateway.addTransport(transport);

      await gateway.notify({ address, body: 'first notice', interventionId }, transport.id);
      expect(transport.sent).toHaveLength(1);

      // Default notify dedups against the durable correlation…
      await gateway.notify({ address, body: 'first notice', interventionId }, transport.id);
      expect(transport.sent).toHaveLength(1);

      // …while a startup replay must re-emit for humans who missed it.
      await gateway.notify({ address, body: 'first notice', interventionId }, transport.id, {
        replay: true,
      });
      expect(transport.sent).toHaveLength(2);

      gateway.destroy();
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('routes a reply after restart and durably deactivates the intervention', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dk-channel-correlation-'));
    const databasePath = join(directory, 'runtime.db');
    const address = { channel: 'telegram', conversationId: 'chat-42' } as const;
    const interventionId = createInterventionId('restart-intervention');
    const outboundId = createChannelMessageId('fake-msg-1');
    const inbound = {
      id: createChannelMessageId('telegram-update-101'),
      address,
      body: 'approved after restart',
      replyToMessageId: outboundId,
      receivedAt: new Date().toISOString(),
    } as const;

    try {
      const firstStore = await SqliteRuntimeStore.open({ databasePath });
      const firstGateway = new ChannelGateway({ correlationStore: firstStore });
      const firstTransport = new FakeChannelTransport('telegram-main');
      firstGateway.addTransport(firstTransport);
      await firstGateway.notify({ address, body: 'Approve?', interventionId }, firstTransport.id);
      firstGateway.destroy();
      firstStore.close();

      const secondStore = await SqliteRuntimeStore.open({ databasePath });
      const secondGateway = new ChannelGateway({ correlationStore: secondStore });
      const secondTransport = new FakeChannelTransport('telegram-main');
      const replies: string[] = [];
      secondGateway.addTransport(secondTransport);
      secondGateway.onInterventionReply((id, reply) => {
        expect(id).toBe(interventionId);
        replies.push(reply.body);
      });
      await secondTransport.receiveMessage(inbound);
      expect(replies).toEqual(['approved after restart']);
      expect(
        await secondStore.listActiveChannelMessageCorrelations({ interventionId }),
      ).toHaveLength(0);
      secondGateway.destroy();
      secondStore.close();

      const thirdStore = await SqliteRuntimeStore.open({ databasePath });
      const thirdGateway = new ChannelGateway({ correlationStore: thirdStore });
      const thirdTransport = new FakeChannelTransport('telegram-main');
      let replayed = false;
      thirdGateway.addTransport(thirdTransport);
      thirdGateway.onInterventionReply(() => {
        replayed = true;
      });
      await thirdTransport.receiveMessage(inbound);
      expect(replayed).toBe(false);
      thirdGateway.destroy();
      thirdStore.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
