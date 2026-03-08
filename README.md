# Very Nice Leads — Blockchain News Lead Bot

<img src="./very-nice-leads-pfp.jpg" width="160" alt="Very Nice Leads bot" />

Monitors Telegram channels for blockchain/DeFi news and sends scored alerts to subscribers via a Telegram bot.

## Prerequisites

- Node.js 22+
- pnpm
- A dedicated Telegram user account (for channel monitoring via MTProto)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Telegram API credentials (from [my.telegram.org](https://my.telegram.org))
- Anthropic API key
- Turso account and database

## Setup

```sh
pnpm install
cp .env.example .env
# Fill in all required values in .env (see Configuration below)
```

### Generate a Telegram session

First-time only. This authenticates the dedicated Telegram user account that will monitor channels:

```sh
pnpm run auth
```

Follow the prompts (phone number, verification code). Copy the output session string into `TELEGRAM_SESSION` in your `.env`.

### Configure channels to monitor

Edit `config/channels.json` to add the Telegram channels the bot should watch:

```json
[
  { "username": "some_channel", "displayName": "Some Channel" },
  { "username": "another_channel" }
]
```

Channels are seeded into the database on startup. Use the `/channels` bot command to list active channels at any time.

## Running

```sh
pnpm run dev
```

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Subscribe to lead alerts (auto-approves admins; sends approval request for others) |
| `/channels` | List all channels currently being monitored |

## Configuration

All configuration is via environment variables (`.env` file).

### Required

| Variable | Description |
|---|---|
| `TELEGRAM_API_ID` | Telegram API ID from my.telegram.org |
| `TELEGRAM_API_HASH` | Telegram API hash from my.telegram.org |
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `ADMIN_IDS` | Comma-separated Telegram user IDs with admin access |
| `TURSO_DATABASE_URL` | Turso database URL (e.g. `libsql://your-db.turso.io`) |
| `TURSO_AUTH_TOKEN` | Turso database auth token |

### Optional

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_SESSION` | _(empty)_ | GramJS session string. Generated via `pnpm run auth` |
| `LLM_MODEL` | `claude-sonnet-4-20250514` | Anthropic model ID for scoring |
| `RELEVANCE_THRESHOLD` | `5` | Score threshold (0-10) for dispatching alerts |

### LLM System Prompt

The scoring prompt is in `prompts/system.txt`. Edit it to tune what the bot considers relevant — no code changes needed.

## Scripts

| Command | Description |
|---|---|
| `pnpm run dev` | Start the bot |
| `pnpm run auth` | Generate Telegram session string |
| `pnpm run test` | Run tests |
| `pnpm run test:watch` | Run tests in watch mode |
| `pnpm run db:generate` | Generate drizzle migration files |
| `pnpm run db:push` | Push schema directly to Turso database |

## Deployment

The bot is deployed on [Railway](https://railway.com). Pushes to `main` trigger automatic deploys. Railway uses Nixpacks to build the project — no Dockerfile needed.
