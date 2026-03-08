import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const processedMessage = sqliteTable('processed_message', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelId: text('channel_id').notNull(),
  messageId: integer('message_id').notNull(),
  messageText: text('message_text'),
  relevanceScore: real('relevance_score'),
  summary: text('summary'),
  dispatched: integer('dispatched', { mode: 'boolean' }).default(false),
  processedAt: integer('processed_at', { mode: 'timestamp' }).defaultNow(),
});

export const messageReview = sqliteTable('message_review', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  processedMessageId: integer('processed_message_id'),
  message: text('message').notNull(),
  botRating: real('bot_rating').notNull(),
  userRating: real('user_rating').notNull(),
  userTgId: text('user_tg_id').notNull(),
  userTgName: text('user_tg_name').notNull(),
  sourceChannel: text('source_channel'),
  createdAt: integer('created_at', { mode: 'timestamp' }).defaultNow(),
});

export const monitoredChannel = sqliteTable('monitored_channel', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelUsername: text('channel_username').notNull().unique(),
  displayName: text('display_name'),
  active: integer('active', { mode: 'boolean' }).default(true),
  addedAt: integer('added_at', { mode: 'timestamp' }).defaultNow(),
});

export const subscriber = sqliteTable('subscriber', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull().unique(),
  name: text('name'),
  active: integer('active', { mode: 'boolean' }).default(true),
  subscribedAt: integer('subscribed_at', { mode: 'timestamp' }).defaultNow(),
});
