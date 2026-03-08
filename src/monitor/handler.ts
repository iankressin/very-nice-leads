import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { TelegramClient } from 'telegram';
import { scoreMessage } from '../analysis/scorer.js';
import { extractUrls, fetchLinks } from '../analysis/link-fetcher.js';
import { dispatchNotification } from '../bot/notifications.js';
import { processedMessage } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import type { AppDatabase } from '../db/client.js';

interface HandlerDeps {
  db: AppDatabase;
  channel: string;
  threshold: number;
  sendNotification: typeof dispatchNotification;
}

/**
 * Register a message handler for a single channel.
 */
export function registerMessageHandler(
  client: TelegramClient,
  deps: HandlerDeps,
): void {
  const { channel } = deps;

  client.addEventHandler(
    (event: NewMessageEvent) => handleNewMessage(event, deps),
    new NewMessage({ chats: [channel] }),
  );

  logger.info('Message handler registered', { channel });
}

/**
 * Register message handlers for multiple channels.
 */
export function registerMultiChannelHandlers(
  client: TelegramClient,
  channels: Array<{ channelUsername: string; displayName: string | null }>,
  deps: Omit<HandlerDeps, 'channel'>,
): void {
  for (const ch of channels) {
    registerMessageHandler(client, {
      ...deps,
      channel: ch.channelUsername,
    });
  }

  logger.info('Multi-channel handlers registered', {
    channelCount: channels.length,
    channels: channels.map((c) => c.channelUsername),
  });
}

export async function handleNewMessage(
  event: NewMessageEvent,
  deps: HandlerDeps,
): Promise<void> {
  const { db, channel, threshold, sendNotification } = deps;
  const message = event.message;

  // GramJS uses `.message` for text content (including captions on media messages).
  // `.text` is a getter that may also return the same value. We check both for safety.
  const messageText = message.text || (message as any).message || '';

  // Log forwarded messages
  if ((message as any).fwdFrom) {
    logger.info('Processing forwarded message', {
      messageId: message.id,
      channel,
      forwarded: true,
    });
  }

  // Skip messages with no text content (e.g. media-only, stickers, etc.)
  if (!messageText.trim()) {
    logger.info('Skipping message with no text content', {
      messageId: message.id,
      channel,
      hasMedia: !!(message as any).media,
    });
    return;
  }

  try {
    logger.info('Processing message', {
      messageId: message.id,
      channel,
      textLength: messageText.length,
      hasMedia: !!(message as any).media,
      isForwarded: !!(message as any).fwdFrom,
    });

    // Extract URLs from message entities and fetch linked content
    const urls = extractUrls(messageText, message.entities as any);
    logger.info('URLs extracted', {
      messageId: message.id,
      channel,
      urlCount: urls.length,
      urls,
    });

    const linkContents = urls.length > 0 ? await fetchLinks(urls) : [];

    const result = await scoreMessage(messageText, linkContents);
    const dispatched = result.relevance_score > threshold;

    // Persist to DB
    const [inserted] = await deps.db
      .insert(processedMessage)
      .values({
        channelId: channel,
        messageId: message.id,
        messageText,
        relevanceScore: result.relevance_score,
        summary: result.summary,
        dispatched,
      })
      .returning();

    logger.info('Message scored', {
      messageId: message.id,
      channel,
      score: result.relevance_score,
      summary: result.summary,
      dispatched,
      linksFound: urls.length,
      linksFetched: linkContents.length,
    });

    if (dispatched) {
      await sendNotification({
        processedMessageId: inserted.id,
        score: result.relevance_score,
        summary: result.summary,
        sourceChannel: channel,
        messageText,
        messageId: message.id,
      });
    }
  } catch (error) {
    logger.error('Failed to process message', {
      messageId: message.id,
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
