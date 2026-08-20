import { describe, expect, it } from 'vitest';
import { WhatsAppAdapter } from './whatsapp-adapter.js';

describe('WhatsAppAdapter inbound delivery', () => {
  it('awaits asynchronous channel handlers and propagates their failure to the adapter boundary', async () => {
    const adapter = new WhatsAppAdapter();
    adapter.onMessage(async () => {
      await Promise.resolve();
      throw new Error('persistence failed');
    });

    const internal = adapter as unknown as {
      ingestMessage(message: {
        id: { _serialized: string };
        body: string;
        from: string;
        fromMe: boolean;
        hasMedia: boolean;
        type: string;
        timestamp: number;
      }): Promise<void>;
    };

    await expect(
      internal.ingestMessage({
        id: { _serialized: 'message-1' },
        body: 'retry',
        from: '15551234567@c.us',
        fromMe: false,
        hasMedia: false,
        type: 'chat',
        timestamp: Math.floor(Date.now() / 1000) + 1,
      }),
    ).rejects.toThrow('persistence failed');
  });
});
