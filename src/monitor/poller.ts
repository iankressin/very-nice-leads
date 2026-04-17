import { TelegramClient } from 'telegram';
import { sql, eq } from 'drizzle-orm';
import { processedMessage } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { processMessage } from './handler.js';
import type { dispatchNotification } from '../bot/notifications.js';
import type { AppDatabase } from '../db/client.js';

interface PollerDeps {
  db: AppDatabase;
  threshold: number;
  sendNotification: typeof dispatchNotification;
}

async function getMaxProcessedId(
  db: AppDatabase,
  channel: string,
): Promise<number> {
  const rows = await db
    .select({ maxId: sql<number | null>`MAX(${processedMessage.messageId})` })
    .from(processedMessage)
    .where(eq(processedMessage.channelId, channel));
  return rows[0]?.maxId ?? 0;
}

export async function pollChannelOnce(
  client: TelegramClient,
  channel: string,
  deps: PollerDeps,
  fetchLimit: number,
): Promise<void> {
  try {
    const lastId = await getMaxProcessedId(deps.db, channel);
    const messages = await client.getMessages(channel, { limit: fetchLimit });
    if (messages.length === 0) return;

    // First run for this channel: seed the baseline with the newest id as an
    // already-claimed row so we don't flood subscribers with historical
    // messages. Subsequent polls will only process messages newer than this.
    if (lastId === 0) {
      const newestId = Math.max(...messages.map((m: any) => m.id));
      await deps.db
        .insert(processedMessage)
        .values({
          channelId: channel,
          messageId: newestId,
          messageText: null,
        })
        .onConflictDoNothing({
          target: [processedMessage.channelId, processedMessage.messageId],
        });
      logger.info('Seeded poller baseline for channel', {
        channel,
        baselineId: newestId,
      });
      return;
    }

    // GramJS returns newest-first; process oldest-first so chronological order is preserved.
    const fresh = messages.filter((m: any) => m.id > lastId).reverse();
    if (fresh.length === 0) return;

    logger.info('Poller found new messages', {
      channel,
      lastSeenId: lastId,
      newCount: fresh.length,
    });

    for (const msg of fresh) {
      await processMessage(msg as any, {
        db: deps.db,
        channel,
        threshold: deps.threshold,
        sendNotification: deps.sendNotification,
      });
    }
  } catch (error) {
    logger.error('Channel poll failed', {
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Poll each monitored channel on a fixed interval. Complements the push-based
 * NewMessage handler: GramJS's per-channel pts can desync (channelDifferenceTooLong),
 * leaving some channels without pushed updates. Polling guarantees delivery
 * regardless of push state.
 */
export function startPolling(
  client: TelegramClient,
  channels: Array<{ channelUsername: string }>,
  deps: PollerDeps,
  intervalMs: number,
  fetchLimit: number = 20,
): () => void {
  logger.info('Starting channel poller', {
    channels: channels.map((c) => c.channelUsername),
    intervalMs,
    fetchLimit,
  });

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    for (const ch of channels) {
      if (stopped) return;
      await pollChannelOnce(client, ch.channelUsername, deps, fetchLimit);
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  // Self-scheduling setTimeout prevents overlapping ticks when a single
  // tick runs longer than intervalMs (slow LLM calls).
  timer = setTimeout(tick, 0);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
