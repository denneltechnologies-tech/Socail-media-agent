import { describe, it, expect } from 'vitest';
import {
  getTelegramConfig,
  isTelegramReady,
  requestTelegramApproval,
  sendTelegramAdminMessage,
  notifyTelegramPostPublished,
  notifyTelegramPostFailed,
} from '../src/notifications/telegram.js';

describe('Telegram Notifications & Approval Service', () => {
  it('returns default config when unconfigured', () => {
    const config = getTelegramConfig();
    expect(config).toBeDefined();
    expect(typeof config.requireApproval).toBe('boolean');
    expect(typeof config.botToken).toBe('string');
    expect(typeof config.chatId).toBe('string');
  });

  it('reports not ready when bot is not running', () => {
    expect(isTelegramReady()).toBe(false);
  });

  it('safely handles approval request when Telegram is unconfigured without throwing', async () => {
    const sent = await requestTelegramApproval({
      postId: '00000000-0000-0000-0000-000000000001',
      username: 'testuser',
      platform: 'twitter',
      contentType: 'text',
      text: 'Test post content for approval',
      hashtags: ['#test', '#ai'],
    });

    expect(sent).toBe(false);
  });

  it('safely handles admin message when Telegram is unconfigured without throwing', async () => {
    const sent = await sendTelegramAdminMessage('Test notification message');
    expect(sent).toBe(false);
  });

  it('safely handles published and failed notifications without throwing', async () => {
    await expect(
      notifyTelegramPostPublished({
        username: 'testuser',
        platform: 'twitter',
        text: 'Published post text',
        hashtags: ['#live'],
        platformUrl: 'https://twitter.com/testuser/status/123',
      }),
    ).resolves.not.toThrow();

    await expect(
      notifyTelegramPostFailed({
        username: 'testuser',
        platform: 'twitter',
        text: 'Failed post text',
        error: 'API rate limit exceeded',
      }),
    ).resolves.not.toThrow();
  });
});
