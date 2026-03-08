# Plan: Very Nice Leads — Blockchain News Lead Bot

> Source PRD: `docs/prd.md`

## Architectural decisions

Durable decisions that apply across all phases:

- **Runtime**: Node.js 20+, TypeScript, `tsx` for development
- **Telegram monitoring**: GramJS (`telegram` package) via MTProto user account — required because bots cannot read channels they don't admin
- **Telegram bot**: grammY (`grammy` package) for notifications and interactions
- **LLM**: Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) using `generateObject` with Zod schemas
- **Database**: SQLite via `better-sqlite3` + `drizzle-orm`. Four tables:
  - `processed_message` — keyed on `(channel_id, message_id)`, stores relevance score, summary, dispatch status
  - `message_review` — user feedback linking bot rating to user rating
  - `monitored_channel` — configurable channel list with `active` flag
  - `subscriber` — bot subscribers with `chat_id` and `active` flag
- **LLM output schema**: `{ relevance_score: number (0–10), summary: string, is_relevant: boolean }`
- **Notification format**: HTML parse mode with score badge, summary, source channel, deep link to original message, inline keyboard for feedback
- **Configuration**: secrets via `.env`, LLM system prompt in a separate file, relevance threshold via env var (default: 5), admin Telegram IDs via env var (comma-separated)
- **Session management**: GramJS `StringSession` stored in env var or file. First login is manual (phone + code); subsequent runs reuse the session
- **Test framework**: vitest, with in-memory SQLite for DB tests and mocked SDKs for external APIs

---

## Phase 1: Single-Channel Tracer Bullet

**User stories**: 1, 2, 14, 18, 20

### What to build

Wire up the thinnest possible end-to-end path: receive a message from ONE hardcoded Telegram channel via GramJS → score it with Claude via Vercel AI SDK (message text only, no link fetching) → if score exceeds threshold, format and send an alert via grammY to a single hardcoded admin subscriber → persist the processed message in SQLite.

This phase proves that all integration layers work together: MTProto auth, LLM structured output, Bot API dispatch, and database writes. The channel and subscriber are hardcoded — dynamic management comes later.

Includes project scaffolding: `package.json`, `tsconfig.json`, drizzle config, all four DB tables (even though only `processed_message` is actively used), `.env.example`, structured logger, and the LLM system prompt file.

### Acceptance criteria

- [ ] Project builds and runs with `tsx`
- [ ] GramJS client authenticates and connects to a configured Telegram channel
- [ ] New messages from the channel trigger the analysis pipeline
- [ ] LLM scorer receives message text and returns a valid `{ relevance_score, summary, is_relevant }` object
- [ ] Messages with `relevance_score > threshold` trigger a formatted HTML alert sent via grammY
- [ ] Alert includes: score, summary, and source channel name
- [ ] Processed messages are persisted in `processed_message` table with score, summary, and dispatch status
- [ ] Messages below threshold are logged but not dispatched
- [ ] Structured logs capture every scoring decision (channel, message ID, score, summary, dispatched or not)
- [ ] All four database tables are created via drizzle migrations (even if not all are used yet)
- [ ] Tests: LLM scorer (mocked SDK, schema validation, prompt construction), database layer (in-memory SQLite, CRUD on `processed_message`)

---

## Phase 2: Link Fetching + Content Enrichment

**User stories**: 10, 15

### What to build

Add URL extraction and content fetching to the analysis pipeline. When a message contains URLs (extracted from Telegram message entities, not regex), fetch each linked page, extract readable text using `@mozilla/readability` + `cheerio`, truncate to ~3000 tokens, and include the fetched content alongside the message text in the LLM prompt.

If a link fetch fails (timeout, 403, invalid URL), the pipeline continues with message text only — no fetch failure should block scoring.

### Acceptance criteria

- [x] URLs are extracted from Telegram message entities (not regex-based)
- [x] For each URL, the page is fetched and readable content is extracted
- [x] Fetched content is truncated to ~3000 tokens before being sent to the LLM
- [x] Link fetch has a 5-second timeout per URL
- [x] Failed fetches (timeout, HTTP error, invalid URL) are logged and skipped — scoring proceeds with message text only
- [x] LLM prompt includes both message text and fetched link content when available
- [x] Custom User-Agent header is set on all fetch requests
- [x] Tests: link fetcher (mocked HTTP responses for successful extraction, timeout, HTTP errors, content truncation), updated scorer tests verifying prompt includes link content

---

## Phase 3: Subscriber Management + Multi-Channel

**User stories**: 3, 6, 7, 8, 9, 12, 13, 19

### What to build

Replace hardcoded channel and subscriber with dynamic management. Seed the `monitored_channel` table from a config file on startup. GramJS subscribes to all active channels. Alerts are dispatched to all active subscribers (not just one hardcoded admin).

Add subscriber onboarding: when a user sends `/start`, check if they're in the admin list (env var). If admin, auto-subscribe. If not, send an approval request to all admins with approve/deny inline buttons. On approval, insert subscriber with `active = true`; on denial, notify the user.

Add deep links to the original Telegram message in alert notifications.

### Acceptance criteria

- [x] Channels are seeded from config on startup into `monitored_channel` table (username + optional display name)
- [x] GramJS monitors all active channels from the `monitored_channel` table
- [x] Alerts are dispatched to ALL active subscribers, not just one
- [x] `/start` command: admins (from env var list) are auto-subscribed
- [x] `/start` command: non-admins trigger an approval request sent to all admins with approve/deny inline buttons
- [x] Admin taps "Approve" → subscriber is added with `active = true` → user is notified
- [x] Admin taps "Deny" → user receives a rejection message
- [x] Alert messages include a deep link (`t.me/{channel}/{message_id}`) to the original message
- [x] Alert HTML format includes: score badge, summary, source channel name, and deep link
- [x] Tests: subscriber management (admin auto-subscribe, approval flow, deny flow), notification dispatcher (HTML format, deep link construction, multi-subscriber dispatch)

---

## Phase 4: Feedback System + Review Storage

**User stories**: 4, 5, 17

### What to build

Implement the feedback loop on alert messages. Each alert already has "Accurate rating" / "Inaccurate rating" inline buttons (added in Phase 1/3). Now wire up the callback handlers:

- **Accurate**: Save a review to `message_review` with `user_rating = bot_rating`. Edit the message to show confirmation.
- **Inaccurate**: Replace the keyboard with two rows of score buttons (0–5 and 6–10). When the user taps a score, save the review with the user's selected score. Edit the message to show confirmation.

Callback data uses prefix encoding: `accurate:{processedMessageId}`, `inaccurate:{processedMessageId}`, `score:{processedMessageId}:{value}`.

### Acceptance criteria

- [x] Tapping "Accurate rating" saves a review with `user_rating = bot_rating` to `message_review`
- [x] After "Accurate" tap, the message is edited to show "Thanks! Rating confirmed" (keyboard removed)
- [x] Tapping "Inaccurate rating" replaces the keyboard with 0–10 score buttons in two rows (0–5, 6–10)
- [x] Tapping a score button saves a review with the user's selected score to `message_review`
- [x] After score selection, the message is edited to show "Thanks! Your rating: X/10" (keyboard removed)
- [x] Review records include: original message text, bot rating, user rating, user Telegram ID, user display name, source channel
- [x] Duplicate/stale callback taps are handled gracefully (no errors, no duplicate reviews)
- [x] Tests: feedback handler (accurate flow, inaccurate flow, score selection, duplicate callback handling, review persistence)

---

## Phase 5: Hardening + Configurability

**User stories**: 11, 16, 21, 22

### What to build

Harden the system for production use. Process ALL message types from monitored channels — text messages, media with captions, forwarded messages. Skip only messages with zero text content.

Add SSRF prevention to the link fetcher: reject redirects to private/internal IP ranges. Add rate limiting to bot message dispatch to stay under Telegram's 30 msg/sec limit. Make the relevance threshold configurable via env var. Move the LLM system prompt to a dedicated config file that can be edited without code changes.

Polish structured logging to cover all pipeline stages consistently.

### Acceptance criteria

- [x] Media messages with captions are processed (caption text is sent to LLM)
- [x] Forwarded messages are processed (forwarded text content is analyzed)
- [x] Messages with zero text content are skipped with a log entry
- [x] Link fetcher rejects redirects to private/internal IP addresses (10.x, 172.16–31.x, 192.168.x, 127.x, ::1)
- [x] Bot message dispatch includes delays between sends to respect Telegram's rate limits
- [x] GramJS respects FLOOD_WAIT responses (handled automatically by the library; verified via logs)
- [x] Relevance threshold is configurable via `RELEVANCE_THRESHOLD` env var (default: 5)
- [x] LLM system prompt is loaded from a dedicated file (not hardcoded), editable without code changes
- [x] Structured logs cover: message received, URLs extracted, link fetch result, LLM score, dispatch decision, notification sent, feedback received
- [x] Tests: link fetcher SSRF prevention (private IP rejection), message handler (caption extraction, forwarded message handling, zero-text skip), config loading (threshold, prompt file)
