import { readFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { monitoredChannel } from './schema.js';
import { logger } from '../utils/logger.js';
import type { AppDatabase } from './client.js';

export interface ChannelConfig {
  username: string;
  displayName?: string;
}

export function loadChannelsConfig(
  configPath?: string,
): ChannelConfig[] {
  const path = configPath || join(process.cwd(), 'config', 'channels.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as ChannelConfig[];
}

/**
 * Seed the monitored_channel table from the channels config file.
 * Uses upsert (INSERT OR IGNORE) — adds new channels but does not remove existing ones.
 */
export async function seedChannels(
  db: AppDatabase,
  channels: ChannelConfig[],
): Promise<void> {
  let added = 0;
  for (const channel of channels) {
    const existing = await db
      .select()
      .from(monitoredChannel)
      .where(sql`${monitoredChannel.channelUsername} = ${channel.username}`);

    if (existing.length === 0) {
      await db.insert(monitoredChannel)
        .values({
          channelUsername: channel.username,
          displayName: channel.displayName ?? null,
        });
      added++;
    }
  }

  logger.info('Channels seeded', {
    totalConfig: channels.length,
    newlyAdded: added,
  });
}

/**
 * Get all active channels from the DB.
 */
export async function getActiveChannels(
  db: AppDatabase,
): Promise<Array<{ id: number; channelUsername: string; displayName: string | null }>> {
  return db
    .select()
    .from(monitoredChannel)
    .where(sql`${monitoredChannel.active} = 1`);
}
