import 'dotenv/config';
import { config } from './config.js';
import { createDb } from './db/client.js';
import { createBot } from './bot/bot.js';
import { setBotInstance, setDbInstance } from './bot/notifications.js';
import { createMonitorClient } from './monitor/client.js';
import { registerMultiChannelHandlers } from './monitor/handler.js';
import { startPolling } from './monitor/poller.js';
import { dispatchNotification } from './bot/notifications.js';
import { loadChannelsConfig, seedChannels, getActiveChannels } from './db/seed-channels.js';
import { logger } from './utils/logger.js';
import {
  processedMessage,
  messageReview,
  monitoredChannel,
  subscriber,
} from './db/schema.js';
import { sql } from 'drizzle-orm';

async function main() {
  logger.info('Starting Very Nice Leads bot');

  // Initialize database
  const db = createDb(config.tursoUrl, config.tursoAuthToken);

  // Create tables if they don't exist
  await db.run(sql`CREATE TABLE IF NOT EXISTS processed_message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    message_text TEXT,
    relevance_score REAL,
    summary TEXT,
    dispatched INTEGER DEFAULT 0,
    processed_at INTEGER DEFAULT (unixepoch())
  )`);
  // Unique (channel, message_id) enables atomic INSERT OR IGNORE claim so the
  // push handler and the fallback poller can't double-process a single message.
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS processed_message_channel_msg_uq
    ON processed_message(channel_id, message_id)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS message_review (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    processed_message_id INTEGER,
    message TEXT NOT NULL,
    bot_rating REAL NOT NULL,
    user_rating REAL NOT NULL,
    user_tg_id TEXT NOT NULL,
    user_tg_name TEXT NOT NULL,
    source_channel TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  )`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS monitored_channel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    active INTEGER DEFAULT 1,
    added_at INTEGER DEFAULT (unixepoch())
  )`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS subscriber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL UNIQUE,
    name TEXT,
    active INTEGER DEFAULT 1,
    subscribed_at INTEGER DEFAULT (unixepoch())
  )`);
  // Migration: add name column to existing subscriber tables
  await db.run(sql`ALTER TABLE subscriber ADD COLUMN name TEXT`).catch(() => {});

  logger.info('Database initialized');

  // Seed channels from config file
  try {
    const channelsConfig = loadChannelsConfig();
    await seedChannels(db, channelsConfig);
  } catch (error) {
    logger.warn('Could not load channels config; skipping channel seeding', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Initialize grammY bot with full options (DB + admin IDs for command handlers)
  const bot = createBot({
    token: config.botToken,
    db,
    adminIds: config.adminIds,
  });
  setBotInstance(bot);
  setDbInstance(db);

  // Start bot polling (non-blocking).
  // Drop pending updates to avoid 409 conflicts during Railway rolling deploys.
  bot.start({
    drop_pending_updates: true,
    onStart: () => logger.info('grammY bot started polling'),
  });

  // Initialize GramJS monitor client
  const monitorClient = await createMonitorClient(
    config.telegramApiId,
    config.telegramApiHash,
    config.telegramSession,
  );

  // Register message handlers for all active channels from DB
  const activeChannels = await getActiveChannels(db);

  if (activeChannels.length === 0) {
    logger.warn('No active channels to monitor');
  } else {
    await registerMultiChannelHandlers(monitorClient, activeChannels, {
      db,
      threshold: config.relevanceThreshold,
      sendNotification: dispatchNotification,
    });

    // Start fallback poller. GramJS push updates can silently stop for
    // individual channels when their per-channel pts drifts
    // (channelDifferenceTooLong). Polling guarantees delivery.
    const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || '60000');
    const pollFetchLimit = Number(process.env.POLL_FETCH_LIMIT || '20');
    startPolling(
      monitorClient,
      activeChannels,
      {
        db,
        threshold: config.relevanceThreshold,
        sendNotification: dispatchNotification,
      },
      pollIntervalMs,
      pollFetchLimit,
    );
  }

  logger.info('Very Nice Leads bot is running', {
    channelCount: activeChannels.length,
    channels: activeChannels.map((c) => c.channelUsername),
    threshold: config.relevanceThreshold,
    adminIds: config.adminIds,
  });

  // Keep the process alive
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await bot.stop();
    await monitorClient.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    await bot.stop();
    await monitorClient.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
