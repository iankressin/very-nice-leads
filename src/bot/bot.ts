import { Bot, InlineKeyboard } from 'grammy';
import { eq, and } from 'drizzle-orm';
import { subscriber, processedMessage, messageReview, monitoredChannel } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import type { AppDatabase } from '../db/client.js';

export interface CreateBotOptions {
  token: string;
  db: AppDatabase;
  adminIds: string[];
}

export function createBot(opts: CreateBotOptions): Bot;
export function createBot(token: string): Bot;
export function createBot(tokenOrOpts: string | CreateBotOptions): Bot {
  if (typeof tokenOrOpts === 'string') {
    // Backward compat: just token, no command handlers
    const bot = new Bot(tokenOrOpts);
    bot.catch((err) => {
      logger.error('Bot error', { error: err.message });
    });
    return bot;
  }

  const { token, db, adminIds } = tokenOrOpts;
  const bot = new Bot(token);

  bot.catch((err) => {
    logger.error('Bot error', { error: err.message });
  });

  // Register commands in Telegram's menu
  bot.api.setMyCommands([
    { command: 'start', description: 'Subscribe to lead alerts' },
    { command: 'channels', description: 'List monitored channels' },
    { command: 'subscribers', description: 'List all subscribers (admin only)' },
  ]).catch((err) => {
    logger.error('Failed to set bot commands', { error: err.message });
  });

  registerStartCommand(bot, db, adminIds);
  registerChannelsCommand(bot, db);
  registerSubscribersCommand(bot, db, adminIds);
  registerApprovalCallbacks(bot, db);
  registerFeedbackCallbacks(bot, db);

  return bot;
}

function registerStartCommand(
  bot: Bot,
  db: AppDatabase,
  adminIds: string[],
): void {
  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id?.toString();
    const chatId = ctx.chat?.id?.toString();

    if (!userId || !chatId) {
      await ctx.reply('Could not identify your account. Please try again.');
      return;
    }

    const isAdmin = adminIds.includes(userId);

    if (isAdmin) {
      // Auto-subscribe admin
      try {
        const name = getUserDisplayName(ctx.from);
        const existing = await db
          .select()
          .from(subscriber)
          .where(eq(subscriber.chatId, chatId));

        if (existing.length > 0) {
          await db.update(subscriber)
            .set({ active: true, name })
            .where(eq(subscriber.chatId, chatId));
        } else {
          await db.insert(subscriber)
            .values({ chatId, name, active: true });
        }

        logger.info('Admin auto-subscribed', { userId, chatId });
        await ctx.reply(
          'Welcome, admin! You have been subscribed to lead alerts.',
        );
      } catch (error) {
        logger.error('Failed to subscribe admin', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        await ctx.reply('Something went wrong. Please try again.');
      }
    } else {
      // Non-admin: send approval request to all admin subscribers
      const allActive = await db
        .select()
        .from(subscriber)
        .where(eq(subscriber.active, true));
      const adminSubscribers = allActive.filter((s) => adminIds.includes(s.chatId));

      if (adminSubscribers.length === 0) {
        await ctx.reply(
          'Your subscription request has been submitted. An admin will review it shortly.',
        );
        logger.warn('No admin subscribers to send approval request to', {
          userId,
        });
        return;
      }

      const userName =
        ctx.from?.username
          ? `@${ctx.from.username}`
          : [ctx.from?.first_name, ctx.from?.last_name]
              .filter(Boolean)
              .join(' ') || 'Unknown user';

      const keyboard = new InlineKeyboard()
        .text('\u2705 Approve', `approve:${userId}:${chatId}`)
        .text('\u274C Deny', `deny:${userId}:${chatId}`);

      const approvalMessage = [
        `\uD83D\uDD14 <b>New subscription request</b>`,
        '',
        `User: ${userName} (ID: ${userId})`,
        `Chat ID: ${chatId}`,
      ].join('\n');

      for (const admin of adminSubscribers) {
        try {
          await bot.api.sendMessage(admin.chatId, approvalMessage, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } catch (error) {
          logger.error('Failed to send approval request to admin', {
            adminChatId: admin.chatId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await ctx.reply(
        'Your subscription request has been submitted. An admin will review it shortly.',
      );
      logger.info('Approval request sent', {
        userId,
        chatId,
        adminCount: adminSubscribers.length,
      });
    }
  });
}

function registerChannelsCommand(bot: Bot, db: AppDatabase): void {
  bot.command('channels', async (ctx) => {
    const channels = await db
      .select()
      .from(monitoredChannel)
      .where(eq(monitoredChannel.active, true));

    if (channels.length === 0) {
      await ctx.reply('No channels are being monitored.');
      return;
    }

    const list = channels
      .map((c) => `• @${c.channelUsername}${c.displayName ? ` (${c.displayName})` : ''}`)
      .join('\n');

    await ctx.reply(`<b>Monitored channels (${channels.length}):</b>\n\n${list}`, {
      parse_mode: 'HTML',
    });
  });
}

function registerSubscribersCommand(bot: Bot, db: AppDatabase, adminIds: string[]): void {
  bot.command('subscribers', async (ctx) => {
    const userId = ctx.from?.id?.toString();

    if (!userId || !adminIds.includes(userId)) {
      await ctx.reply('This command is only available to admins.');
      return;
    }

    const subscribers = await db
      .select()
      .from(subscriber);

    if (subscribers.length === 0) {
      await ctx.reply('No subscribers yet.');
      return;
    }

    const list = subscribers
      .map((s) => {
        const label = s.name ? `${s.name} (<code>${s.chatId}</code>)` : `<code>${s.chatId}</code>`;
        return `• ${label} — ${s.active ? 'active' : 'inactive'}`;
      })
      .join('\n');

    await ctx.reply(`<b>Subscribers (${subscribers.length}):</b>\n\n${list}`, {
      parse_mode: 'HTML',
    });
  });
}

function registerApprovalCallbacks(bot: Bot, db: AppDatabase): void {
  bot.callbackQuery(/^approve:(\d+):(.+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const userId = match[1];
    const chatId = match[2];

    try {
      const existing = await db
        .select()
        .from(subscriber)
        .where(eq(subscriber.chatId, chatId));

      const chat = await bot.api.getChat(chatId).catch(() => null);
      const name = chat ? getUserDisplayName(chat as any) : null;

      if (existing.length > 0) {
        await db.update(subscriber)
          .set({ active: true, name })
          .where(eq(subscriber.chatId, chatId));
      } else {
        await db.insert(subscriber)
          .values({ chatId, name, active: true });
      }

      try {
        await bot.api.sendMessage(
          chatId,
          'Your subscription has been approved! You will now receive lead alerts.',
        );

      } catch (sendError) {
        logger.warn('Could not notify approved user', {
          chatId,
          error:
            sendError instanceof Error ? sendError.message : String(sendError),
        });
      }

      await ctx.editMessageText(
        `\u2705 Approved subscription for user ${userId} (chat: ${chatId})`,
      );

      logger.info('Subscription approved', { userId, chatId, approvedBy: ctx.from?.id });
    } catch (error) {
      logger.error('Failed to approve subscriber', {
        userId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.answerCallbackQuery({ text: 'Error processing approval.' });
    }
  });

  bot.callbackQuery(/^deny:(\d+):(.+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const userId = match[1];
    const chatId = match[2];

    try {
      try {
        await bot.api.sendMessage(
          chatId,
          'Your subscription request has been denied by an admin.',
        );
      } catch (sendError) {
        logger.warn('Could not notify denied user', {
          chatId,
          error:
            sendError instanceof Error ? sendError.message : String(sendError),
        });
      }

      await ctx.editMessageText(
        `\u274C Denied subscription for user ${userId} (chat: ${chatId})`,
      );

      logger.info('Subscription denied', { userId, chatId, deniedBy: ctx.from?.id });
    } catch (error) {
      logger.error('Failed to deny subscriber', {
        userId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.answerCallbackQuery({ text: 'Error processing denial.' });
    }
  });
}

function getUserDisplayName(from: { first_name?: string; last_name?: string; username?: string } | undefined): string {
  if (!from) return 'Unknown';
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return fullName || from.username || 'Unknown';
}

function registerFeedbackCallbacks(bot: Bot, db: AppDatabase): void {
  // "Accurate rating" — user confirms bot's score
  bot.callbackQuery(/^accurate:(\d+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const processedMessageId = Number(match[1]);
    const userTgId = ctx.from?.id?.toString() || '';

    try {
      const [msg] = await db
        .select()
        .from(processedMessage)
        .where(eq(processedMessage.id, processedMessageId));

      if (!msg) {
        await ctx.answerCallbackQuery({ text: 'This message is no longer available.' });
        return;
      }

      const existingReview = await db
        .select()
        .from(messageReview)
        .where(
          and(
            eq(messageReview.processedMessageId, processedMessageId),
            eq(messageReview.userTgId, userTgId),
          ),
        );

      if (existingReview.length > 0) {
        await ctx.answerCallbackQuery({ text: 'You have already rated this message.' });
        return;
      }

      const botRating = msg.relevanceScore ?? 0;
      const userTgName = getUserDisplayName(ctx.from);

      await db.insert(messageReview)
        .values({
          processedMessageId,
          message: msg.messageText || '',
          botRating,
          userRating: botRating,
          userTgId,
          userTgName,
          sourceChannel: msg.channelId,
        });

      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      await ctx.answerCallbackQuery({ text: 'Thanks! Rating confirmed.' });

      logger.info('Accurate feedback received', {
        processedMessageId,
        botRating,
        userTgId,
      });
    } catch (error) {
      logger.error('Failed to process accurate feedback', {
        processedMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.answerCallbackQuery({ text: 'Error processing feedback.' });
    }
  });

  // "Inaccurate rating" — show score selection buttons
  bot.callbackQuery(/^inaccurate:(\d+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const processedMessageId = Number(match[1]);

    try {
      const [msg] = await db
        .select()
        .from(processedMessage)
        .where(eq(processedMessage.id, processedMessageId));

      if (!msg) {
        await ctx.answerCallbackQuery({ text: 'This message is no longer available.' });
        return;
      }

      const keyboard = new InlineKeyboard();
      for (let i = 0; i <= 5; i++) {
        keyboard.text(String(i), `score:${processedMessageId}:${i}`);
      }
      keyboard.row();
      for (let i = 6; i <= 10; i++) {
        keyboard.text(String(i), `score:${processedMessageId}:${i}`);
      }

      await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      await ctx.answerCallbackQuery();

      logger.info('Inaccurate feedback — showing score buttons', {
        processedMessageId,
      });
    } catch (error) {
      logger.error('Failed to process inaccurate feedback', {
        processedMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.answerCallbackQuery({ text: 'Error processing feedback.' });
    }
  });

  // Score selection — user picks a custom score
  bot.callbackQuery(/^score:(\d+):(\d+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const processedMessageId = Number(match[1]);
    const userScore = Number(match[2]);
    const userTgId = ctx.from?.id?.toString() || '';

    try {
      const [msg] = await db
        .select()
        .from(processedMessage)
        .where(eq(processedMessage.id, processedMessageId));

      if (!msg) {
        await ctx.answerCallbackQuery({ text: 'This message is no longer available.' });
        return;
      }

      const existingReview = await db
        .select()
        .from(messageReview)
        .where(
          and(
            eq(messageReview.processedMessageId, processedMessageId),
            eq(messageReview.userTgId, userTgId),
          ),
        );

      if (existingReview.length > 0) {
        await ctx.answerCallbackQuery({ text: 'You have already rated this message.' });
        return;
      }

      const botRating = msg.relevanceScore ?? 0;
      const userTgName = getUserDisplayName(ctx.from);

      await db.insert(messageReview)
        .values({
          processedMessageId,
          message: msg.messageText || '',
          botRating,
          userRating: userScore,
          userTgId,
          userTgName,
          sourceChannel: msg.channelId,
        });

      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      await ctx.answerCallbackQuery({ text: `Thanks! Your rating: ${userScore}/10` });

      logger.info('Score feedback received', {
        processedMessageId,
        botRating,
        userRating: userScore,
        userTgId,
      });
    } catch (error) {
      logger.error('Failed to process score feedback', {
        processedMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.answerCallbackQuery({ text: 'Error processing feedback.' });
    }
  });
}
