# PRD: Very Nice Leads — Blockchain News Lead Bot

## Problem Statement

The sales and BD teams at sqd.ai currently monitor Telegram news channels manually to find leads — new blockchains, DeFi protocols, and other systems that could benefit from sqd.ai's enterprise blockchain data infrastructure. This manual monitoring is time-consuming, inconsistent, and doesn't scale as the number of relevant channels grows. Team members miss leads because they can't watch all channels simultaneously, and there's no systematic way to evaluate or track which news items are actually relevant.

## Solution

Build **Very Nice Leads**, a Telegram bot system that automatically monitors a configurable list of Telegram channels, uses an LLM to evaluate each message's relevance to sqd.ai's business, and dispatches formatted alerts to subscribed team members when relevant content is found. Each alert includes a relevance score and summary, and users can provide feedback on the bot's accuracy to build a training dataset for future LLM improvements.

The system consists of two Telegram integrations:
1. A **GramJS MTProto client** (user account) that monitors third-party channels where the bot has no admin access.
2. A **grammY bot** that sends notifications to subscribers and handles feedback interactions.

## User Stories

1. As a **sales team member**, I want to receive automatic alerts when a new blockchain or DeFi protocol is announced in Telegram channels, so that I can reach out to potential customers before competitors do.
2. As a **BD team member**, I want each alert to include a relevance score (0–10) and a one-line summary, so that I can quickly prioritize which leads to pursue.
3. As a **BD team member**, I want alerts to link directly to the original Telegram message, so that I can read the full context without searching for it.
4. As a **subscriber**, I want to rate each alert as "Accurate" or "Inaccurate", so that the system can learn from my feedback over time.
5. As a **subscriber**, when I rate an alert as "Inaccurate", I want to provide my own 0–10 relevance score via inline buttons, so that my feedback is precise and effortless.
6. As a **subscriber**, I want to send `/start` to the bot to request access, so that onboarding is self-service.
7. As an **admin**, I want to receive a notification when someone requests access, so that I can approve or deny them with a button tap.
8. As an **admin**, I want to approve or deny subscriber requests via inline buttons, so that I don't need to edit config files.
9. As an **admin**, I want the list of admin Telegram IDs to be configurable via environment variables, so that I can control who has admin privileges without code changes.
10. As a **team member**, I want the bot to analyze link content (not just the message text), so that alerts account for the full context of shared articles and posts.
11. As a **team member**, I want the bot to process all message types from monitored channels (including media captions and forwarded messages), so that no potential leads are missed.
12. As an **operator**, I want to seed the bot with an initial list of channels to monitor, so that it works out of the box after deployment.
13. As an **operator**, I want to add or remove monitored channels via the database, so that I can adjust monitoring without restarting the bot (bot commands for this are a future enhancement).
14. As an **operator**, I want structured logging for every LLM scoring decision, so that I can debug why a message was or wasn't flagged.
15. As an **operator**, I want the bot to handle link fetch failures gracefully (skip unfetchable links and score based on message text alone), so that a single broken URL doesn't block the pipeline.
16. As an **operator**, I want the bot to respect Telegram rate limits and FLOOD_WAIT responses, so that the monitoring account isn't banned.
17. As a **data analyst**, I want all feedback stored in a `message_review` table with both bot and user ratings, so that this data can be used for future LLM training.
18. As a **data analyst**, I want processed messages logged in a `processed_message` table with scores and dispatch status, so that I can analyze the bot's performance over time.
19. As a **subscriber**, I want alerts formatted in clean, readable HTML with the score, summary, source channel, and original message link, so that I can absorb the information at a glance.
20. As a **subscriber**, I want the bot to only alert me when content scores above a threshold (>5), so that I'm not overwhelmed with low-relevance noise.
21. As an **operator**, I want the relevance threshold to be configurable, so that it can be tuned without code changes.
22. As an **admin**, I want the system prompt for the LLM to be stored in a config file, so that I can tune scoring criteria without code changes.

## Delivery Phases

### Phase 1: Channel Monitor + LLM Scorer

**Goal**: End-to-end message analysis pipeline. Messages are received, analyzed, and results are logged — but no Telegram bot notifications yet. Output is structured logs / CLI.

**Modules**:
- **GramJS Client** — Authenticate as a dedicated Telegram user account, subscribe to NewMessage events on configured channels, extract message text + URLs + metadata.
- **Link Fetcher** — For each URL in a message, fetch the page, extract readable text via `@mozilla/readability` + `cheerio`, truncate to ~3000 tokens, handle timeouts (5s) and errors gracefully.
- **LLM Scorer** — Send message text + fetched link content to Claude via Vercel AI SDK's `generateObject` with a Zod schema. Return `{ relevance_score, summary, is_relevant }`.
- **Database (schema + client)** — SQLite via `better-sqlite3` + `drizzle-orm`. Create all four tables (`message_review`, `processed_message`, `monitored_channel`, `subscriber`). Seed `monitored_channel` from config.
- **Config** — Environment variable loading, channel seed list, LLM system prompt file, relevance threshold.
- **Logger** — Structured logging for all scoring decisions.

**Deliverable**: Running the bot logs every message from monitored channels with its relevance score and summary. Processed messages are persisted in `processed_message`. No Telegram bot output yet.

### Phase 2: Bot Notifications + Subscriber Management

**Goal**: Subscribers receive formatted alerts for relevant messages. Admin approval flow for new subscribers.

**Modules**:
- **grammY Bot Setup** — Initialize bot with token, configure middleware.
- **Notification Dispatcher** — Format alert messages in HTML (score, summary, source channel, deep link to original message). Attach inline keyboard with "Accurate rating" / "Inaccurate rating" buttons. Send to all active subscribers.
- **Subscriber Management** — `/start` command handler: if user is in admin list, auto-subscribe; otherwise, notify admins with approve/deny inline buttons. Store subscriber in `subscriber` table with `active` flag.
- **Integration** — Wire the scorer output (from Phase 1) into the dispatcher: if `relevance_score > threshold`, dispatch notification.

**Deliverable**: End-to-end flow from channel message → LLM analysis → bot alert to subscribers. Admins can approve new subscribers.

### Phase 3: Feedback System + Review Storage

**Goal**: Users can rate alerts and their feedback is persisted for future LLM training.

**Modules**:
- **Feedback Handler** — Handle callback queries from inline keyboard buttons.
  - "Accurate rating": save review with `user_rating = bot_rating`, edit message to confirm.
  - "Inaccurate rating": replace keyboard with 0–10 score buttons (two rows: 0–5, 6–10), save user's selected score, edit message to confirm.
- **Review Storage** — Persist all feedback in `message_review` table with: original message, bot rating, user rating, user Telegram ID, user display name, source channel.

**Deliverable**: Full feedback loop. All user ratings are stored and queryable for analysis and future training.

## Implementation Decisions

### Architecture

- **Two Telegram integrations in one process**: GramJS (MTProto user client) for reading channels + grammY (Bot API) for sending notifications. Both run concurrently in a single Node.js process.
- **GramJS over Bot API for monitoring**: Telegram bots cannot read channels they don't admin. Since we monitor third-party public channels, MTProto via a dedicated user account is required.
- **SQLite for persistence**: Single-process bot handling ~100–500 messages/day. SQLite eliminates all operational overhead. Drizzle ORM allows future migration to Postgres if needed.
- **Vercel AI SDK for LLM**: `generateObject` with Zod schemas provides typed, validated structured output. Provider-swappable if Claude needs to be replaced.
- **grammY over Telegraf**: TypeScript-first, actively maintained, clean middleware API.

### Database Schema

Four tables:
- `processed_message` — Deduplication and scoring log. Keyed on `(channel_id, message_id)`.
- `message_review` — User feedback on bot ratings. Links to processed messages.
- `monitored_channel` — Configurable list of channels to watch. Seeded from config, manageable via DB.
- `subscriber` — Bot subscribers with `active` flag and `chat_id`.

### Message Processing

- Process ALL message types from monitored channels (text, captions, forwards, etc.). Skip only messages with zero text content.
- Extract URLs from Telegram message entities (not regex parsing).
- Link fetching: `fetch` + `cheerio` + `@mozilla/readability`. 5-second timeout per URL. On failure, analyze message text only.
- Truncate fetched content to ~3000 tokens to fit LLM context.
- No cross-channel deduplication for MVP. Each channel message is processed independently.

### LLM Scoring

- System prompt stored in a config file (not hardcoded), tunable without code changes.
- Output schema: `{ relevance_score: number (0–10), summary: string, is_relevant: boolean }`.
- Threshold for dispatching alerts: `relevance_score > 5` (configurable via env var).

### Notification Format

- HTML parse mode.
- Includes: score badge, one-line summary, source channel name, deep link to original message (`t.me/{channel}/{message_id}`).
- Inline keyboard: two buttons — "Accurate rating" / "Inaccurate rating".

### Subscriber Management

- Admin Telegram IDs configured via environment variable (comma-separated).
- `/start` command: if user is admin → auto-subscribe. Otherwise → send approve/deny request to all admins via inline buttons.
- Approved users are inserted into `subscriber` table with `active = true`.
- Denied users receive a rejection message.

### Feedback Flow

- "Accurate rating" → save `user_rating = bot_rating` → edit message to confirm.
- "Inaccurate rating" → replace keyboard with two rows of score buttons (0–5, 6–10) → user taps score → save → edit message to confirm.
- Callback data encoding: prefix-based (e.g., `accurate:{messageId}`, `inaccurate:{messageId}`, `score:{messageId}:{score}`).

### Session Management

- GramJS `StringSession` persisted to environment variable or file. First login requires interactive phone + code auth; subsequent runs reuse the session.

### Configuration

- All secrets (API keys, bot token, session string) via `.env`.
- Channel seed list via config file or env var.
- LLM system prompt via separate config file.
- Relevance threshold via env var (default: 5).
- Admin Telegram IDs via env var.

### SSRF Prevention

- Link fetcher sets a custom User-Agent header.
- Respects robots.txt.
- 5-second timeout per URL.
- Does not follow redirects to internal/private network addresses.

## Testing Decisions

### Testing Philosophy

Tests should verify **external behavior** through module interfaces, not implementation details. A good test:
- Calls a module's public interface with known inputs.
- Asserts on the output or observable side effects.
- Does not mock internal implementation details — only external dependencies (LLM API, Telegram API, network fetches).
- Is deterministic and fast.

### Modules to Test

**All modules will have tests:**

1. **Link Fetcher** — Unit tests with mocked HTTP responses. Verify: readable text extraction, timeout handling, graceful failure on bad URLs, content truncation, SSRF prevention (reject private IP redirects).

2. **LLM Scorer** — Unit tests with mocked Vercel AI SDK responses. Verify: correct schema validation, proper prompt construction (message + link content), threshold logic, handling of malformed LLM output.

3. **Message Handler (Monitor)** — Unit tests verifying: URL extraction from message entities, correct dispatching to link fetcher and scorer, processing of different message types (text, captions, forwards), deduplication via `processed_message` table.

4. **Notification Dispatcher** — Unit tests with mocked grammY bot. Verify: correct HTML formatting, inline keyboard structure, dispatch to all active subscribers, correct deep link construction.

5. **Feedback Handler** — Unit tests with mocked callback queries. Verify: "Accurate" flow saves correct review, "Inaccurate" flow presents score buttons, score selection saves correct review, message editing after feedback, handling of duplicate/stale callbacks.

6. **Subscriber Management** — Unit tests verifying: `/start` auto-subscribes admins, `/start` sends approval request for non-admins, approve/deny buttons work correctly, subscriber table state changes.

7. **Database Layer** — Integration tests against a real SQLite in-memory database. Verify: schema creation, CRUD operations on all tables, deduplication constraints, timestamp defaults.

### Test Framework

- Use `vitest` as the test runner (fast, TypeScript-native, good mocking support).
- Database tests use in-memory SQLite (`:memory:`).
- External API calls (Telegram, LLM) are mocked at the SDK boundary.

## Out of Scope

- **LLM training/fine-tuning** using collected feedback data (data is collected but training is a future effort).
- **Cross-channel deduplication** (same news from multiple channels will generate multiple alerts).
- **Bot commands for channel management** (`/addchannel`, `/removechannel`) — planned for a future phase after MVP.
- **X/Twitter or RSS feed monitoring** — future enhancement; same analysis pipeline, different monitors.
- **Web dashboard** for analytics or channel management.
- **Multi-instance / horizontal scaling** — single process, single SQLite file for MVP.
- **Message queuing / backpressure handling** (e.g., Redis queue between monitor and scorer).
- **Monitoring/alerting infrastructure** (e.g., health checks, uptime monitoring).
- **Docker/deployment setup** — documented in architecture but not part of the feature PRD.
- **Interactive Telegram auth flow** — assumed to be done once manually before deployment.

## Further Notes

- **Rate Limiting**: GramJS handles `FLOOD_WAIT` automatically. The grammY bot should add delays between messages to stay under Telegram's 30 msg/sec limit when dispatching to multiple subscribers.
- **Session Expiry**: If the GramJS session expires, the bot stops monitoring. This should be logged clearly. Re-auth requires manual intervention (phone + code). Consider adding a health-check mechanism in a future iteration.
- **Content Safety**: The link fetcher should not execute JavaScript. Using `fetch` + `cheerio` (no headless browser) inherently prevents this.
- **Database Backups**: Out of scope for the bot itself, but operators should set up a daily cron job to copy the SQLite file.
- **Channel Seed Format**: The initial channel list should support both `channel_username` (without @) and optional `display_name` for human-readable logging.
- **Future Consideration**: The `message_review` table is designed to support LLM training. The `bot_rating` vs `user_rating` comparison will be the primary signal for prompt tuning.
