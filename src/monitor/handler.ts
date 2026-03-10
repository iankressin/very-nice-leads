import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { Raw } from 'telegram/events/Raw.js';
import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl/index.js';
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
 *
 * Resolves the full channel entity (not just InputPeer) and fetches its
 * latest message to ensure Telegram's server is primed to push updates
 * for this channel to our session.
 */
export async function registerMessageHandler(
  client: TelegramClient,
  deps: HandlerDeps,
): Promise<void> {
  const { channel } = deps;

  let chatFilter: any[];
  try {
    // Use getEntity (not getInputEntity) to fully resolve the channel
    // and populate the entity cache, which helps GramJS match incoming updates.
    const entity = await client.getEntity(channel) as any;
    const channelId = entity.id;
    // Build the marked peer ID: -100<channelId> (Telegram's standard format)
    const numericId = BigInt(`-100${channelId}`);
    chatFilter = [numericId];
    logger.info('Message handler registered', {
      channel,
      resolvedId: numericId.toString(),
      entityType: entity.className,
    });

    // Fetch latest message from the channel to prime the update state.
    // This tells Telegram we're interested in this channel's updates.
    try {
      const messages = await client.getMessages(channel, { limit: 1 });
      logger.info('Primed channel update state', {
        channel,
        latestMessageId: messages[0]?.id,
      });
    } catch (err) {
      logger.warn('Could not prime channel update state', {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (error) {
    // If entity resolution fails at startup we log clearly and skip this channel
    // rather than registering a handler that will silently drop all events.
    logger.error('Failed to resolve channel entity — handler NOT registered', {
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  client.addEventHandler(
    (event: NewMessageEvent) => handleNewMessage(event, deps),
    new NewMessage({ chats: chatFilter }),
  );
}

/**
 * Register message handlers for multiple channels.
 */
export async function registerMultiChannelHandlers(
  client: TelegramClient,
  channels: Array<{ channelUsername: string; displayName: string | null }>,
  deps: Omit<HandlerDeps, 'channel'>,
): Promise<void> {
  // Register a catch-all raw handler to log any incoming channel message updates.
  // This helps diagnose whether GramJS is receiving updates at all.
  client.addEventHandler((update: any) => {
    if (update instanceof Api.UpdateNewChannelMessage) {
      const msg = update.message;
      const peerId = (msg as any)?.peerId;
      logger.info('Raw channel update received', {
        messageId: (msg as any)?.id,
        peerId: peerId ? `${peerId.className}(${peerId.channelId})` : 'unknown',
      });
    }
  }, new Raw({}));

  for (const ch of channels) {
    await registerMessageHandler(client, {
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
