import { describe, expect, it, vi } from 'vitest';
import { TelegramChannelAdapter } from './telegram-adapter.js';

function makeBot() {
  const handlers = new Map<string, (context: never) => void | Promise<void>>();
  const sendMessage = vi.fn(
    async (_chatId: string | number, _text: string, _options?: Record<string, unknown>) => ({
      message_id: 77,
    }),
  );
  const start = vi.fn(async () => undefined);
  const bot = {
    api: {
      getMe: vi.fn(async () => ({ username: 'dark_kitchen_bot' })),
      sendMessage,
      setWebhook: vi.fn(async () => true),
      deleteWebhook: vi.fn(async () => true),
    },
    init: vi.fn(async () => undefined),
    start,
    stop: vi.fn(async () => undefined),
    handleUpdate: vi.fn(async () => undefined),
    on: (event: string, handler: (context: never) => void | Promise<void>) => {
      handlers.set(event, handler);
    },
  };
  return { bot, handlers, sendMessage, start };
}

describe('TelegramChannelAdapter', () => {
  it('fails closed without an inbound chat allowlist', () => {
    expect(() => new TelegramChannelAdapter('123:secret', {}, async () => makeBot().bot)).toThrow(
      /allowed chat ID/,
    );
  });

  it('preserves pending polling replies and emits stable provider reply IDs', async () => {
    const fake = makeBot();
    const adapter = new TelegramChannelAdapter(
      '123:secret',
      { allowedChatIds: ['42'], allowedSenderIds: ['7'] },
      async () => fake.bot,
    );
    const received: Array<{ id: string; replyToId?: string; text: string }> = [];
    adapter.onMessage((message) => {
      received.push({
        id: message.id,
        text: message.content.text,
        ...(message.replyToId ? { replyToId: message.replyToId } : {}),
      });
    });
    await adapter.connect();

    expect(fake.start).toHaveBeenCalledWith({ drop_pending_updates: false });
    await fake.handlers.get('message:text')?.({
      from: { id: 7, first_name: 'Human' },
      chat: { id: 42 },
      message: {
        message_id: 100,
        text: 'approved',
        date: 1_700_000_000,
        reply_to_message: { message_id: 77 },
      },
      answerCallbackQuery: async () => undefined,
    } as never);

    expect(received).toEqual([{ id: '100', replyToId: '77', text: 'approved' }]);
    await adapter.disconnect();
  });

  it('drops replies from an unauthorized chat or sender', async () => {
    const fake = makeBot();
    const adapter = new TelegramChannelAdapter(
      '123:secret',
      { allowedChatIds: ['42'], allowedSenderIds: ['7'] },
      async () => fake.bot,
    );
    const received: string[] = [];
    adapter.onMessage((message) => {
      received.push(message.content.text);
    });
    await adapter.connect();
    const handler = fake.handlers.get('message:text');
    for (const { chatId, senderId } of [
      { chatId: 99, senderId: 7 },
      { chatId: 42, senderId: 8 },
    ]) {
      await handler?.({
        from: { id: senderId },
        chat: { id: chatId },
        message: { message_id: chatId + senderId, text: 'attack', date: 1_700_000_000 },
        answerCallbackQuery: async () => undefined,
      } as never);
    }
    expect(received).toEqual([]);
    await adapter.disconnect();
  });

  it('correlates callback actions to the notification message', async () => {
    const fake = makeBot();
    const adapter = new TelegramChannelAdapter(
      '123:secret',
      { allowedChatIds: ['42'] },
      async () => fake.bot,
    );
    const received: Array<{ action?: string; replyToId?: string }> = [];
    adapter.onMessage((message) => {
      received.push({
        ...(message.content.callbackData ? { action: message.content.callbackData } : {}),
        ...(message.replyToId ? { replyToId: message.replyToId } : {}),
      });
    });
    await adapter.connect();
    await fake.handlers.get('callback_query:data')?.({
      from: { id: 7 },
      callbackQuery: {
        id: 'callback-1',
        data: 'retry',
        message: { message_id: 77, chat: { id: 42 }, date: 1_700_000_000 },
      },
      answerCallbackQuery: async () => undefined,
    } as never);
    expect(received).toEqual([{ action: 'retry', replyToId: '77' }]);
    await adapter.disconnect();
  });

  it('sends plain text within Telegram limits and rejects oversized callback data', async () => {
    const fake = makeBot();
    const adapter = new TelegramChannelAdapter(
      '123:secret',
      { allowedChatIds: ['42'] },
      async () => fake.bot,
    );
    await adapter.connect();
    await adapter.send({ chatId: '42', text: `start-${'x'.repeat(5_000)}-end` });
    const options = fake.sendMessage.mock.calls[0]?.[2] ?? {};
    expect(fake.sendMessage.mock.calls[0]?.[1]).toHaveLength(4_096);
    expect(options).not.toHaveProperty('parse_mode');

    await expect(
      adapter.send({
        chatId: '42',
        text: 'choose',
        buttons: [[{ label: 'retry', callbackData: 'x'.repeat(65) }]],
      }),
    ).rejects.toThrow(/1-64/);
    await adapter.disconnect();
  });

  it('refuses webhook mode without HTTPS and a valid secret', async () => {
    const fake = makeBot();
    const adapter = new TelegramChannelAdapter(
      '123:secret',
      {
        mode: 'webhook',
        allowedChatIds: ['42'],
        webhookUrl: 'http://example.com',
        webhookSecret: 'valid_secret',
      },
      async () => fake.bot,
    );
    await expect(adapter.connect()).rejects.toThrow(/HTTPS/);
  });
});
