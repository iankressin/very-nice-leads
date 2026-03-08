import { InlineKeyboard, type Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { subscriber } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import type { AppDatabase } from '../db/client.js';

export interface NotificationPayload {
  processedMessageId: number;
  score: number;
  summary: string;
  sourceChannel: string;
  messageText: string;
  /** @deprecated Use multi-subscriber dispatch instead. Kept for backward compat. */
  chatId?: string;
  /** Original Telegram message ID for deep linking */
  messageId?: number;
}

let botInstance: Bot | null = null;
let dbInstance: AppDatabase | null = null;

export function setBotInstance(bot: Bot): void {
  botInstance = bot;
}

export function setDbInstance(db: AppDatabase): void {
  dbInstance = db;
}

/**
 * Get all active subscriber chat IDs from the database.
 */
async function getActiveSubscriberChatIds(db: AppDatabase): Promise<string[]> {
  const rows = await db
    .select({ chatId: subscriber.chatId })
    .from(subscriber)
    .where(eq(subscriber.active, true));
  return rows.map((r) => r.chatId);
}

/**
 * Dispatch a notification to all active subscribers.
 * If a specific chatId is provided in the payload (backward compat), it sends only to that chat.
 * Otherwise, it queries the subscriber table for all active subscribers.
 */
export async function dispatchNotification(
  payload: NotificationPayload,
): Promise<void> {
  if (!botInstance) throw new Error('Bot not initialized');

  const messageHtml = formatAlert(payload);
  const keyboard = new InlineKeyboard()
    .text('\u2705 Confirm score', `accurate:${payload.processedMessageId}`)
    .text('\u270F\uFE0F Rescore', `inaccurate:${payload.processedMessageId}`);

  // Determine target chat IDs
  let chatIds: string[];
  if (payload.chatId) {
    // Backward compat: single chatId provided
    chatIds = [payload.chatId];
  } else if (dbInstance) {
    chatIds = await getActiveSubscriberChatIds(dbInstance);
  } else {
    logger.warn('No DB instance set and no chatId in payload; cannot dispatch');
    return;
  }

  if (chatIds.length === 0) {
    logger.warn('No active subscribers to dispatch to', {
      processedMessageId: payload.processedMessageId,
    });
    return;
  }

  // Rate limit: ~30 msg/sec Telegram limit => ~35ms delay between sends
  const RATE_LIMIT_DELAY_MS = 35;

  for (let i = 0; i < chatIds.length; i++) {
    const chatId = chatIds[i];
    try {
      await botInstance.api.sendMessage(chatId, messageHtml, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });

      logger.info('Notification dispatched', {
        chatId,
        score: payload.score,
        processedMessageId: payload.processedMessageId,
      });
    } catch (error) {
      logger.error('Failed to dispatch notification', {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Add delay between sends to respect Telegram rate limits (except after last message)
    if (i < chatIds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
    }
  }
}

export function formatAlert(payload: NotificationPayload): string {
  const scoreEmoji =
    payload.score >= 9 ? '\uD83D\uDFE2' : payload.score >= 7 ? '\uD83D\uDFE1' : '\uD83D\uDD34';

  // Build deep link if messageId is available
  // Strip leading @ from channel username if present
  const channelName = payload.sourceChannel.replace(/^@/, '');
  const deepLink = payload.messageId
    ? `\n\n\uD83D\uDD17 <a href="https://t.me/${channelName}/${payload.messageId}">View original message</a>`
    : '';

  return [
    `${scoreEmoji} <b>New Lead Detected</b> (Relevance Score: ${payload.score}/10)`,
    '',
    `<i>"${escapeHtml(truncate(payload.messageText, 200))}"</i>`,
    '',
    `\uD83D\uDCCA <b>Why relevant:</b> ${escapeHtml(payload.summary)}`,
    '',
    `\uD83D\uDCE1 <b>Source:</b> ${escapeHtml(payload.sourceChannel)}${deepLink}`,
  ].join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}
