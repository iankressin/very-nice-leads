# Very Nice Leads — Blockchain News Lead Bot

<img src="./very-nice-leads-pfp.jpg" width="160" alt="Very Nice Leads bot" />

Monitors Telegram channels for blockchain/DeFi news and sends scored alerts to subscribers via a Telegram bot.

## Prerequisites

- Node.js 20+
- A dedicated Telegram user account (for channel monitoring via MTProto)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Telegram API credentials (from [my.telegram.org](https://my.telegram.org))
- Anthropic API key

## Setup

```sh
npm install
cp .env.example .env
# Fill in all required values in .env (see Configuration below)
```

### Generate a Telegram session

First-time only. This authenticates the dedicated Telegram user account that will monitor channels:

```sh
npm run auth
```

Follow the prompts (phone number, verification code). Copy the output session string into `TELEGRAM_SESSION` in your `.env`.

## Running

```sh
npm run dev
```

## Configuration

All configuration is via environment variables (`.env` file).

### Required

| Variable | Description |
|---|---|
| `TELEGRAM_API_ID` | Telegram API ID from my.telegram.org |
| `TELEGRAM_API_HASH` | Telegram API hash from my.telegram.org |
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `MONITORED_CHANNEL` | Channel username to monitor (without `@`) |
| `ADMIN_CHAT_ID` | Telegram chat ID to receive alerts |

### Optional

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_SESSION` | _(empty)_ | GramJS session string. Generated via `npm run auth` |
| `LLM_MODEL` | `claude-sonnet-4-20250514` | Anthropic model ID for scoring |
| `RELEVANCE_THRESHOLD` | `5` | Score threshold (0-10) for dispatching alerts |
| `DATABASE_URL` | `./data/bot.db` | Path to SQLite database file |

### LLM System Prompt

The scoring prompt is in `prompts/system.txt`. Edit it to tune what the bot considers relevant — no code changes needed.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the bot |
| `npm run auth` | Generate Telegram session string |
| `npm run test` | Run tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run db:generate` | Generate drizzle migration files |
| `npm run db:push` | Push schema directly to database |
