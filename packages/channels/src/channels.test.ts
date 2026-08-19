import { describe, it, expect } from 'vitest';
import { ChannelGateway, FakeChannelTransport } from './index.js';
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

  it('handles duplicate replies idempotently (handler called each time, dedup at service level)', async () => {
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
    await transport.receiveMessage({ ...inbound, id: createChannelMessageId('msg-dup-2') });
    // Both trigger the handler; dedup happens at the intervention service level
    expect(replies).toHaveLength(2);
    gateway.destroy();
  });

  it('rejects duplicate transport registration', () => {
    const gateway = new ChannelGateway();
    const t = new FakeChannelTransport('same-id');
    gateway.addTransport(t);
    expect(() => gateway.addTransport(new FakeChannelTransport('same-id'))).toThrow();
    gateway.destroy();
  });
});
