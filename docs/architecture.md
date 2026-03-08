# System: Very Nice Leads — Blockchain News Lead Bot

## Requirements

### Functional

1. **Channel Monitoring** — Monitor a configurable list of Telegram channels for new messages in real-time
2. **Content Analysis** — For each new message, use an LLM to evaluate relevance to blockchain/DeFi ecosystem news (new chains, protocols, data infrastructure)
3. **Link Extraction** — If a message contains links, fetch the linked content and include it in the LLM analysis
4. **Structured Scoring** — LLM produces a deterministic JSON output: relevance score (0–10), one-liner summary, and relevance flag
5. **Notification Dispatch** — If score > 5, forward a formatted alert to all subscribers of the "Very Nice Leads" Telegram bot
6. **User Feedback** — Each alert includes inline buttons for "Accurate rating" / "Inaccurate rating"
   - Accurate: saves review with `user_rating = bot_rating`
   - Inaccurate: prompts user for their own 0–10 score, then saves review
7. **Review Storage** — Persist all feedback in a `message_review` table for future LLM training (training itself is out of scope)

### Non-Functional

- **Latency**: Message → Alert delivery < 30 seconds (excluding link fetch time)
- **Availability**: Best-effort; acceptable to miss messages during brief downtime (not mission-critical)
- **Throughput**: ~100–500 messages/day across all monitored channels
- **Minimal Manual Intervention**: Once configured, the bot runs autonomously
- **Observability**: Structured logging for debugging LLM scoring decisions

### Constraints

- Small team (1–2 engineers)
- Internal tool for sales/BD — no public users
- Budget-conscious: minimize infrastructure costs
- Must use Telegram as both input (channels) and output (bot notifications)

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Very Nice Leads Bot                               │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────────┐  │
│  │   Channel    │    │   Analysis   │    │   Notification        │  │
│  │   Monitor    │───▶│   Pipeline   │───▶│   Dispatcher          │  │
│  │  (GramJS)    │    │              │    │   (grammY Bot)        │  │
│  └──────────────┘    │  ┌────────┐  │    └───────────┬───────────┘  │
│         │            │  │  Link  │  │                │              │
│         │            │  │ Fetcher│  │    ┌───────────▼───────────┐  │
│  Telegram MTProto    │  └────────┘  │    │   Feedback Handler    │  │
│  (user account)      │  ┌────────┐  │    │   (Inline Keyboards)  │  │
│                      │  │  LLM   │  │    └───────────┬───────────┘  │
│                      │  │ Scorer │  │                │              │
│                      │  └────────┘  │    ┌───────────▼───────────┐  │
│                      └──────────────┘    │      SQLite DB        │  │
│                             │            │  (drizzle-orm)        │  │
│                             │            └───────────────────────┘  │
│                      ┌──────▼──────┐                                │
│                      │  Vercel AI  │                                │
│                      │    SDK      │                                │
│                      │  (Claude)   │                                │
│                      └─────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Telegram Channel
    │
    │ new message (MTProto event)
    ▼
┌──────────────┐
│   Channel    │  1. Receive raw message text + metadata
│   Monitor    │  2. Extract any URLs from message
└──────┬───────┘
       │
       ▼
┌──────────────┐
│    Link      │  3. For each URL: fetch page, extract readable text
│   Fetcher    │     (cheerio + mozilla/readability)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  LLM Scorer  │  4. Send message + fetched content to LLM
│  (Vercel AI  │  5. Receive structured JSON:
│   SDK)       │     { relevance_score, summary, is_relevant }
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Threshold   │  6. If relevance_score > 5:
│   Check      │     → dispatch notification
└──────┬───────┘     Else: log and discard
       │
       ▼
┌──────────────┐
│ Notification │  7. Format alert message (HTML)
│  Dispatcher  │  8. Attach inline keyboard (Accurate / Inaccurate)
│  (grammY)    │  9. Send to all subscribers
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Feedback    │  10. User taps button → callback query
│  Handler     │  11. Save review to message_review table
└──────────────┘
```

---

## Component Details

### 1. Channel Monitor (GramJS)

**Technology**: `telegram` (GramJS) — TypeScript MTProto client

**Why MTProto (not Bot API)**: Telegram bots cannot read messages in channels unless added as admin. Since we're monitoring third-party public channels where we have no admin access, we need the Telegram Client API (MTProto) via a user account.

**Responsibilities**:
- Authenticate as a dedicated Telegram user account
- Subscribe to new messages in configured channels via `NewMessage` event handler
- Extract message text, sender info, timestamp, and channel metadata
- Extract URLs from message entities
- Pass messages to the Analysis Pipeline

**Configuration**:
```typescript
// channels.config.ts
export const MONITORED_CHANNELS = [
  'channel_username_1',
  'channel_username_2',
  // ...loaded from env or DB
];
```

**Session Management**: Persist the GramJS `StringSession` to a file or environment variable. First login requires interactive phone + code auth; subsequent runs reuse the session.

### 2. Link Fetcher

**Technology**: `fetch` + `cheerio` + `@mozilla/readability`

**Responsibilities**:
- For each URL found in a message, fetch the page HTML
- Extract the readable article text (strip nav, ads, boilerplate)
- Truncate to a reasonable size (~3000 tokens) to fit within LLM context
- Handle timeouts (5s per URL) and errors gracefully (skip unfetchable links)

**Why not a headless browser**: Most blockchain news sites render server-side. A simple fetch + readability extraction covers 90%+ of cases without the overhead of Puppeteer/Playwright.

### 3. LLM Scorer (Vercel AI SDK)

**Technology**: `ai` (Vercel AI SDK) + `@ai-sdk/anthropic` + `zod`

**Responsibilities**:
- Accept message text + optional fetched link content
- Call Claude via `generateObject` with a Zod schema
- Return typed, validated JSON

**Schema**:
```typescript
const AnalysisSchema = z.object({
  relevance_score: z.number().min(0).max(10)
    .describe('How relevant this content is to new blockchain/DeFi launches, 0=irrelevant, 10=perfect lead'),
  summary: z.string()
    .describe('One sentence explaining why this is relevant for sqd.ai sales'),
  is_relevant: z.boolean()
    .describe('True if relevance_score > 5'),
});
```

**System Prompt** (stored in a config file, tunable without code changes):
```
You are a lead qualification assistant for sqd.ai, a company that provides
enterprise blockchain data infrastructure (indexing, querying, APIs).

Evaluate the following Telegram message for sales relevance. A message is
relevant if it mentions:
- A new blockchain, L1, L2, or rollup launching
- A new DeFi protocol, DEX, lending platform, or bridge
- A blockchain project raising funding or announcing mainnet
- Any system that would need blockchain data indexing or APIs
- New data-intensive blockchain applications (gaming, NFT platforms, etc.)

Rate from 0 (completely irrelevant) to 10 (perfect sales lead).
```

### 4. Notification Dispatcher (grammY)

**Technology**: `grammy` — TypeScript-first Telegram Bot framework

**Responsibilities**:
- Send formatted alert messages to all bot subscribers
- Attach inline keyboard with feedback buttons
- Handle callback queries from button presses

**Message Format** (HTML parse mode):
```html
🔔 <b>New Lead Detected</b> (Score: 8/10)

<i>"Polygon announces new zkEVM rollup with $50M ecosystem fund..."</i>

📊 <b>Why relevant:</b> New L2 rollup launch with significant funding —
potential enterprise data infrastructure customer.

📎 <a href="https://t.me/channel/123">Original message</a>
```

**Inline Keyboard**:
```
[ ✅ Accurate rating ]  [ ❌ Inaccurate rating ]
```

### 5. Feedback Handler

**Flow for "Accurate rating"**:
1. User taps "Accurate rating"
2. Bot saves review with `user_rating = bot_rating`
3. Bot edits the message to show "Thanks! Rating confirmed ✓"

**Flow for "Inaccurate rating"**:
1. User taps "Inaccurate rating"
2. Bot replaces keyboard with a row of buttons: `[0] [1] [2] [3] [4] [5] [6] [7] [8] [9] [10]`
3. User taps their score
4. Bot saves review with the user's selected score
5. Bot edits the message to show "Thanks! Your rating: X/10"

**Why inline buttons for the 0–10 score**: Telegram supports inline keyboard button grids. A single row of 11 small buttons (or two rows: 0–5 and 6–10) is the most UX-friendly approach — no typing required, single tap, and works on both mobile and desktop. Alternatively, a two-row layout:
```
[ 0 ] [ 1 ] [ 2 ] [ 3 ] [ 4 ] [ 5 ]
[ 6 ] [ 7 ] [ 8 ] [ 9 ] [ 10 ]
```

### 6. Database (SQLite + drizzle-orm)

**Technology**: `better-sqlite3` + `drizzle-orm`

**Why SQLite**: This is a single-process internal bot handling a few hundred records/day. SQLite eliminates all operational overhead (no server, no credentials, no network). The database is a single file deployed alongside the bot. If the project ever outgrows SQLite, drizzle-orm makes migration to Postgres straightforward.

**Schema**:

```typescript
// schema.ts
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const messageReview = sqliteTable('message_review', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  message: text('message').notNull(),           // original channel message
  botRating: real('bot_rating').notNull(),       // LLM relevance score
  userRating: real('user_rating').notNull(),     // user's rating (same as bot if "accurate")
  userTgId: text('user_tg_id').notNull(),        // reviewer's Telegram user ID
  userTgName: text('user_tg_name').notNull(),    // reviewer's Telegram display name
  sourceChannel: text('source_channel'),         // channel where message was found
  createdAt: integer('created_at', { mode: 'timestamp' }).defaultNow(),
});

export const processedMessage = sqliteTable('processed_message', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelId: text('channel_id').notNull(),
  messageId: integer('message_id').notNull(),    // Telegram message ID (dedupe key)
  relevanceScore: real('relevance_score'),
  summary: text('summary'),
  dispatched: integer('dispatched', { mode: 'boolean' }).default(false),
  processedAt: integer('processed_at', { mode: 'timestamp' }).defaultNow(),
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
  chatId: text('chat_id').notNull().unique(),    // Telegram chat ID to send alerts to
  active: integer('active', { mode: 'boolean' }).default(true),
  subscribedAt: integer('subscribed_at', { mode: 'timestamp' }).defaultNow(),
});
```

---

## Technology Stack Summary

| Component | Technology | Package |
|-----------|-----------|---------|
| Channel monitoring | GramJS (MTProto client) | `telegram` |
| Bot framework | grammY | `grammy` |
| LLM integration | Vercel AI SDK + Claude | `ai`, `@ai-sdk/anthropic` |
| Structured output | Zod schemas | `zod` |
| Link content extraction | Readability | `@mozilla/readability`, `cheerio` |
| Database | SQLite | `better-sqlite3`, `drizzle-orm` |
| Runtime | Node.js 20+ | TypeScript with tsx |

---

## Project Structure

```
thomas-news-bot/
├── src/
│   ├── index.ts                 # Entry point — starts both clients
│   ├── config.ts                # Environment variables, thresholds
│   ├── monitor/
│   │   ├── client.ts            # GramJS client setup + auth
│   │   └── handler.ts           # NewMessage event handler
│   ├── analysis/
│   │   ├── scorer.ts            # LLM scoring via Vercel AI SDK
│   │   ├── link-fetcher.ts      # URL fetch + readability extraction
│   │   └── prompt.ts            # System prompt (configurable)
│   ├── bot/
│   │   ├── bot.ts               # grammY bot setup
│   │   ├── notifications.ts     # Message formatting + dispatch
│   │   └── feedback.ts          # Inline keyboard + callback handlers
│   ├── db/
│   │   ├── schema.ts            # drizzle-orm table definitions
│   │   ├── client.ts            # Database connection
│   │   └── migrations/          # SQL migration files
│   └── utils/
│       └── logger.ts            # Structured logging
├── drizzle.config.ts
├── package.json
├── tsconfig.json
├── .env                         # API keys, bot token, session string
└── docs/
    └── architecture.md          # This file
```

---

## Key Decisions (ADRs)

### ADR-001: Use GramJS (MTProto) for Channel Monitoring

**Status**: Accepted

**Context**: We need to monitor third-party Telegram channels where we are not admins. Telegram bots can only receive messages from channels where they're added as administrators. We need an alternative approach.

**Decision**: Use GramJS (`telegram` npm package), a TypeScript MTProto client library, to authenticate as a dedicated user account and subscribe to channel messages.

**Consequences**:
- *Positive*: Can monitor any public channel; native TypeScript; no native dependencies; high-level API
- *Negative*: Requires a dedicated Telegram user account; session management needed; potential ToS risk if abused
- *Mitigation*: Use a dedicated account (not personal); respect rate limits; avoid aggressive scraping patterns

**Alternatives Considered**:
- **Telegram Bot API**: Rejected — bots cannot read channels they don't admin
- **TDLib (tdl)**: Rejected — requires native C++ compilation, harder to deploy
- **@mtproto/core**: Rejected — too low-level, no high-level abstractions

---

### ADR-002: Use Vercel AI SDK for LLM Integration

**Status**: Accepted

**Context**: We need to call an LLM to analyze messages and return structured JSON. The output must be typed and validated. We want provider flexibility.

**Decision**: Use the Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) with Zod schemas via `generateObject`.

**Consequences**:
- *Positive*: Zod schema = single source of truth for types + validation + LLM constraint; provider-swappable; zero JSON parsing boilerplate
- *Negative*: Additional abstraction layer; slight delay in supporting bleeding-edge provider features
- *Mitigation*: Can fall back to direct Anthropic SDK if needed for specific features

**Alternatives Considered**:
- **Anthropic SDK directly**: Viable but requires manual JSON parsing, no type inference on output, vendor lock-in
- **OpenAI SDK**: Strong structured outputs but vendor lock-in
- **LangChain.js**: Heavy dependency tree, overkill for a single structured call

---

### ADR-003: Use SQLite for Persistence

**Status**: Accepted

**Context**: The bot needs to store user feedback (~100–500 records/day), processed message logs, and channel configuration. Single-process application.

**Decision**: Use SQLite via `better-sqlite3` with `drizzle-orm` for type-safe queries.

**Consequences**:
- *Positive*: Zero operational overhead; zero cost; trivial deployment; sufficient for the workload
- *Negative*: Single-writer; no built-in replication; not suitable for multi-instance deployment
- *Mitigation*: If the project outgrows SQLite, drizzle-orm supports migration to Postgres with minimal query changes

**Alternatives Considered**:
- **PostgreSQL**: Overkill — operational overhead unjustified for this scale
- **Supabase**: Adds external dependency and free-tier pausing risk
- **Turso**: Edge distribution irrelevant for a single-instance bot

---

### ADR-004: Use grammY for Bot Framework

**Status**: Accepted

**Context**: Need a Telegram Bot API framework for sending notifications and handling inline keyboard interactions.

**Decision**: Use grammY — a TypeScript-first Telegram Bot framework.

**Consequences**:
- *Positive*: Excellent TypeScript types; active maintenance; clean middleware API; full Bot API support
- *Negative*: Slightly smaller community than Telegraf
- *Mitigation*: grammY's documentation is comprehensive; migration from Telegraf is well-documented

**Alternatives Considered**:
- **Telegraf**: Mature but less TypeScript-native
- **node-telegram-bot-api**: Too low-level for interactive keyboard flows

---

## Failure Modes

| Failure | Impact | Mitigation |
|---------|--------|------------|
| GramJS session expires | Stops monitoring | Alert on disconnect; re-auth flow documented |
| LLM API down/slow | Messages queued, delayed alerts | Retry with exponential backoff; log for manual review |
| LLM returns unexpected output | Message skipped | Zod validation catches; log failed analyses |
| Link fetch fails (timeout/403) | LLM scores without link context | Graceful fallback — analyze message text only |
| SQLite file corrupted | Lose review history | Daily file backup (cron cp) |
| FLOOD_WAIT from Telegram | Temporary pause in monitoring | Respect the wait duration; GramJS handles automatically |
| Bot token revoked | Alerts stop | Health check pings; alert via separate channel |

---

## Scaling Strategy

### Current (MVP)
- Single process on a VPS or container
- SQLite file on local disk
- One dedicated Telegram user account
- One bot token

### Future (if needed)
- Move to Postgres if multi-instance deployment required
- Add Redis queue between monitor and scorer for backpressure handling
- Support X/Twitter and RSS feeds as additional sources (same analysis pipeline, different monitors)
- Web dashboard for managing channels and viewing analytics (reads from same DB)
- Fine-tune or few-shot the LLM prompt using collected `message_review` data

---

## Security Considerations

- **Telegram session string**: Store in `.env` or secret manager, never commit to git
- **Bot token**: Same treatment as session string
- **LLM API key**: Store in `.env`
- **Rate limiting**: Respect Telegram's FLOOD_WAIT; add delays between bot messages to avoid hitting 30 msg/sec limit
- **Link fetching**: Set User-Agent header; respect robots.txt; timeout aggressively; do not follow redirects to internal networks (SSRF prevention)

---

## Deployment

**Recommended**: A single Docker container on a VPS (e.g., Railway, Fly.io, or a $5 DigitalOcean droplet).

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
COPY drizzle/ ./drizzle/
VOLUME ["/app/data"]  # SQLite DB persistence
ENV DATABASE_URL=/app/data/bot.db
CMD ["node", "dist/index.js"]
```

**Key deployment notes**:
- Mount a persistent volume for the SQLite database file
- Use environment variables for all secrets
- Set up a process manager (or Docker restart policy) for auto-recovery
- Optional: cron job to backup the SQLite file daily
