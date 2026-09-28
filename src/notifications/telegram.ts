import { Bot, InlineKeyboard } from 'grammy';
import { eq, inArray, and } from 'drizzle-orm';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { settingsStore } from '../config/settings-store.js';
import { db, schema } from '../db/index.js';
import { JobType } from '../config/constants.js';
import { enqueueJob } from '../core/queue.js';

let bot: Bot | null = null;
let isPolling = false;

// In-memory tracker for users currently typing an edit: chatId -> postId
const pendingEdits = new Map<string, string>();

export function isTelegramReady(): boolean {
  return bot !== null && isPolling;
}

export function getTelegramConfig(): { botToken: string; chatId: string; requireApproval: boolean } {
  const botToken = settingsStore.get('TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = settingsStore.get('TELEGRAM_CHAT_ID', env.TELEGRAM_CHAT_ID || '').trim();
  const requireApprovalVal = settingsStore.get('REQUIRE_APPROVAL', String(env.REQUIRE_APPROVAL));
  const requireApproval = requireApprovalVal === 'true' || requireApprovalVal === '1';
  return { botToken, chatId, requireApproval };
}

export async function initTelegram(): Promise<void> {
  const { botToken, chatId } = getTelegramConfig();

  if (!botToken) {
    logger.info('Telegram bot token not configured, Telegram notifications disabled');
    return;
  }

  try {
    // If bot was already running, stop previous instance
    if (bot) {
      await destroyTelegram().catch(() => {});
    }

    bot = new Bot(botToken);

    // Bot command handlers
    bot.command('start', async (ctx) => {
      const fromId = ctx.from?.id ? String(ctx.from.id) : 'unknown';
      await ctx.reply(
        `👋 <b>Welcome to Social Agent AI Bot!</b>\n\n` +
        `Your Telegram Chat ID is: <code>${fromId}</code>\n\n` +
        `Copy this Chat ID into your dashboard settings to receive post approval requests and status notifications.`,
        { parse_mode: 'HTML' },
      );
    });

    bot.command('status', async (ctx) => {
      await ctx.reply(`🟢 <b>Social Agent AI Bot is active and listening for approvals.</b>`, {
        parse_mode: 'HTML',
      });
    });

    // Callback Query: Approve Post
    bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
      const postId = typeof ctx.match === 'string' ? ctx.match : (ctx.match?.[1] ?? '');
      const fromId = ctx.from?.id ? String(ctx.from.id) : '';

      // Verify admin if chatId is configured
      if (chatId && fromId && fromId !== chatId) {
        await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
        return;
      }

      if (!postId) {
        await ctx.answerCallbackQuery({ text: 'Invalid post ID', show_alert: true });
        return;
      }

      try {
        const [post] = await db
          .update(schema.posts)
          .set({ status: 'publishing', errorMessage: null, updatedAt: new Date() })
          .where(
            and(
              eq(schema.posts.id, postId),
              inArray(schema.posts.status, ['review', 'scheduled', 'failed']),
            ),
          )
          .returning();

        if (!post) {
          const [existing] = await db
            .select({ status: schema.posts.status })
            .from(schema.posts)
            .where(eq(schema.posts.id, postId))
            .limit(1);

          if (!existing) {
            await ctx.answerCallbackQuery({ text: 'Post not found', show_alert: true });
          } else if (existing.status === 'published') {
            await ctx.answerCallbackQuery({ text: 'This post is already published!', show_alert: true });
          } else {
            await ctx.answerCallbackQuery({ text: `Post is currently "${existing.status}"`, show_alert: true });
          }
          return;
        }

        await enqueueJob(JobType.PUBLISH_POST, {
          postId: post.id,
          platform: post.platform,
          accountId: post.accountId,
        });

        await ctx.answerCallbackQuery({ text: '✅ Approved! Queued for publishing.' });

        // Update the original Telegram message to show approved state
        const currentText = ctx.callbackQuery.message?.text ?? '';
        await ctx.editMessageText(
          `${currentText}\n\n━━━━━━━━━━━━━━━━━━━━\n✅ <b>APPROVED & QUEUED FOR PUBLISHING</b> by Admin`,
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        logger.error('Error handling Telegram post approval', {
          error: err instanceof Error ? err.message : String(err),
          postId,
        });
        await ctx.answerCallbackQuery({ text: 'Failed to approve post. Check logs.', show_alert: true });
      }
    });

    // Callback Query: Reject Post
    bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
      const postId = typeof ctx.match === 'string' ? ctx.match : (ctx.match?.[1] ?? '');
      const fromId = ctx.from?.id ? String(ctx.from.id) : '';

      if (chatId && fromId && fromId !== chatId) {
        await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
        return;
      }

      if (!postId) return;

      try {
        await db
          .update(schema.posts)
          .set({
            status: 'failed',
            errorMessage: 'Rejected by admin via Telegram',
            updatedAt: new Date(),
          })
          .where(eq(schema.posts.id, postId));

        await ctx.answerCallbackQuery({ text: '❌ Post rejected.' });

        const currentText = ctx.callbackQuery.message?.text ?? '';
        await ctx.editMessageText(
          `${currentText}\n\n━━━━━━━━━━━━━━━━━━━━\n❌ <b>REJECTED</b> by Admin`,
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        logger.error('Error handling Telegram post rejection', {
          error: err instanceof Error ? err.message : String(err),
          postId,
        });
        await ctx.answerCallbackQuery({ text: 'Failed to reject post.', show_alert: true });
      }
    });

    // Callback Query: Edit Content Request
    bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
      const postId = typeof ctx.match === 'string' ? ctx.match : (ctx.match?.[1] ?? '');
      const fromId = ctx.from?.id ? String(ctx.from.id) : '';

      if (chatId && fromId && fromId !== chatId) {
        await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
        return;
      }

      if (!postId) return;

      if (ctx.chat?.id) {
        pendingEdits.set(String(ctx.chat.id), postId);
      }

      await ctx.answerCallbackQuery();
      await ctx.reply(
        `✏️ <b>Send the new text for this post:</b>\n` +
        `Type or paste your revised content directly below and send it.`,
        { parse_mode: 'HTML' },
      );
    });

    // Listen for text messages for editing pending posts
    bot.on('message:text', async (ctx) => {
      const chatStrId = ctx.chat?.id ? String(ctx.chat.id) : '';
      if (!pendingEdits.has(chatStrId)) return;

      const postId = pendingEdits.get(chatStrId)!;
      pendingEdits.delete(chatStrId);

      const newText = ctx.message.text.trim();
      if (!newText) {
        await ctx.reply('⚠️ Text cannot be empty. Edit cancelled.');
        return;
      }

      try {
        const [updated] = await db
          .update(schema.posts)
          .set({ text: newText, updatedAt: new Date() })
          .where(eq(schema.posts.id, postId))
          .returning();

        if (!updated) {
          await ctx.reply('⚠️ Post not found or already deleted.');
          return;
        }

        const keyboard = new InlineKeyboard()
          .text('✅ Approve & Post Now', `approve:${postId}`)
          .text('❌ Reject', `reject:${postId}`)
          .row()
          .text('✏️ Edit Again', `edit:${postId}`);

        await ctx.reply(
          `📝 <b>Post Content Updated!</b>\n\n` +
          `<b>New Text:</b>\n${escapeHtml(updated.text)}\n\n` +
          `Would you like to approve this revised version?`,
          { parse_mode: 'HTML', reply_markup: keyboard },
        );
      } catch (err) {
        logger.error('Failed to update post via Telegram edit', {
          error: err instanceof Error ? err.message : String(err),
          postId,
        });
        await ctx.reply('⚠️ Failed to update post in database.');
      }
    });

    bot.catch((err) => {
      logger.error('Telegram bot error', {
        error: err.error instanceof Error ? err.error.message : String(err.error),
      });
    });

    // Start long-polling in background
    bot.start({
      onStart: (botInfo) => {
        isPolling = true;
        logger.info(`Telegram Bot @${botInfo.username} started successfully`);
      },
    });
  } catch (err) {
    logger.error('Failed to initialize Telegram Bot', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function destroyTelegram(): Promise<void> {
  if (bot && isPolling) {
    try {
      await bot.stop();
    } catch {
      // Ignore cleanup error
    }
    bot = null;
    isPolling = false;
    logger.info('Telegram Bot stopped');
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Sends an interactive approval request to Telegram admin
 */
export async function requestTelegramApproval(details: {
  postId: string;
  username: string;
  platform: string;
  contentType: string;
  text: string;
  hashtags?: string[];
  mediaUrls?: string[];
}): Promise<boolean> {
  const { chatId } = getTelegramConfig();
  if (!bot || !chatId) {
    logger.debug('Telegram not configured or ready, skipping Telegram approval request');
    return false;
  }

  const platformIcons: Record<string, string> = {
    twitter: '🐦', instagram: '📸', youtube: '▶️', tiktok: '🎵',
  };
  const icon = platformIcons[details.platform] || '📱';
  const tags = details.hashtags && details.hashtags.length > 0 ? details.hashtags.join(' ') : 'none';

  const keyboard = new InlineKeyboard()
    .text('✅ Approve & Post Now', `approve:${details.postId}`)
    .text('❌ Reject', `reject:${details.postId}`)
    .row()
    .text('✏️ Edit Content', `edit:${details.postId}`);

  const messageText =
    `🔔 <b>POST APPROVAL REQUEST</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${icon} <b>Platform:</b> ${details.platform.toUpperCase()}\n` +
    `👤 <b>Account:</b> @${escapeHtml(details.username)}\n` +
    `📦 <b>Type:</b> ${escapeHtml(details.contentType)}\n` +
    `🏷️ <b>Hashtags:</b> ${escapeHtml(tags)}\n\n` +
    `📝 <b>Content Preview:</b>\n` +
    `${escapeHtml(details.text)}\n\n` +
    `<i>Tap an action below to review:</i>`;

  try {
    await bot.api.sendMessage(chatId, messageText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    logger.info(`Telegram approval request sent for post ${details.postId}`);
    return true;
  } catch (err) {
    logger.error('Failed to send Telegram approval request', {
      error: err instanceof Error ? err.message : String(err),
      postId: details.postId,
    });
    return false;
  }
}

/**
 * Sends a general text notification to Telegram admin
 */
export async function sendTelegramAdminMessage(message: string): Promise<boolean> {
  const { chatId } = getTelegramConfig();
  if (!bot || !chatId) {
    return false;
  }

  try {
    await bot.api.sendMessage(chatId, message, { parse_mode: 'HTML' });
    return true;
  } catch (err) {
    logger.error('Failed to send Telegram admin message', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function notifyTelegramPostPublished(details: {
  username: string;
  platform: string;
  text: string;
  hashtags: string[];
  platformUrl?: string | null;
}): Promise<void> {
  const preview = details.text.length > 100 ? details.text.substring(0, 100) + '...' : details.text;
  const linkText = details.platformUrl ? `<a href="${details.platformUrl}">View Live Post</a>` : '—';

  await sendTelegramAdminMessage(
    `🚀 <b>POST PUBLISHED</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Account:</b> @${escapeHtml(details.username)}\n` +
    `📡 <b>Platform:</b> ${details.platform.toUpperCase()}\n` +
    `📝 <b>Content:</b> ${escapeHtml(preview)}\n` +
    `🔗 <b>Link:</b> ${linkText}`,
  );
}

export async function notifyTelegramPostFailed(details: {
  username: string;
  platform: string;
  text: string;
  error: string;
}): Promise<void> {
  const preview = details.text.length > 80 ? details.text.substring(0, 80) + '...' : details.text;

  await sendTelegramAdminMessage(
    `❌ <b>POST PUBLISHING FAILED</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Account:</b> @${escapeHtml(details.username)}\n` +
    `📡 <b>Platform:</b> ${details.platform.toUpperCase()}\n` +
    `📝 <b>Content:</b> ${escapeHtml(preview)}\n` +
    `⚠️ <b>Error:</b> ${escapeHtml(details.error)}`,
  );
}
