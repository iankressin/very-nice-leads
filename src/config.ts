import 'dotenv/config';

export const config = {
  // Telegram MTProto (GramJS)
  telegramApiId: Number(process.env.TELEGRAM_API_ID),
  telegramApiHash: process.env.TELEGRAM_API_HASH!,
  telegramSession: process.env.TELEGRAM_SESSION || '',

  // Telegram Bot (grammY)
  botToken: process.env.BOT_TOKEN!,

  // LLM
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  llmModel: process.env.LLM_MODEL || 'claude-sonnet-4-20250514',

  // Admin IDs (comma-separated Telegram user IDs)
  adminIds: (process.env.ADMIN_IDS || process.env.ADMIN_CHAT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),

  // Backward compat: keep adminChatId for any legacy usage
  adminChatId: process.env.ADMIN_CHAT_ID || '',

  // Thresholds
  relevanceThreshold: Number(process.env.RELEVANCE_THRESHOLD || '5'),

  // Turso database
  tursoUrl: process.env.TURSO_DATABASE_URL!,
  tursoAuthToken: process.env.TURSO_AUTH_TOKEN!,
};
