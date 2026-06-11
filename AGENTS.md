# Socrates — Telegram Persona Bot

A Node.js/Express application that wraps OpenRouter and imitates a specific real person over Telegram as convincingly as possible. The bot reads a `person.md` profile, keeps per-contact chat history and long-term memory in S3, and reproduces human texting behaviour: realistic reply delays based on time of day, typing indicators, multi-message bursts, unprompted followups, and silence when a real person wouldn't reply.

## Architecture

```
Telegram (long polling)
      │ incoming message
      ▼
src/bot.js  ── append to chat.jsonl ──► src/store.js ──► S3 (write-through, in-memory cache)
      │
      ▼
src/llm.js  ── person.md + memory.txt + chat history + current time ──► OpenRouter
      │            returns the JSON decision (see "LLM contract")
      ▼
src/humanize.js ── waits answerDelay, shows "typing…", sends bursts ──► Telegram
      │
      └── schedules followup (fires only if the contact stays silent)
      └── if memoryUpdateNeeded: second LLM call distills chat → memory.txt
```

### File map

| File | Purpose |
|---|---|
| `src/index.js` | Entrypoint. Express server (`/health`, `/status`), boots polling, restores persisted timers. |
| `src/config.js` | Loads and validates all env variables. Fails fast on missing ones. |
| `src/telegram.js` | Dependency-free Telegram Bot API client: long polling, `sendMessage`, `sendChatAction(typing)`. |
| `src/bot.js` | Conversation engine: allow-list check, debounce, scheduling of replies/followups, restart recovery, memory trigger. |
| `src/llm.js` | OpenRouter wrapper. Builds the persona prompt, parses/sanitizes the JSON decision, runs memory distillation. |
| `src/humanize.js` | Human realism: typing duration ∝ message length, burst splitting, inter-burst pauses, long-delay timers. |
| `src/store.js` | Data layer over S3: `chat.jsonl` (append+trim in ONE function), `memory.txt`, `state.json`. |
| `src/storage.js` | Raw S3 get/put (AWS SDK v3, works with AWS, MinIO, Cloudflare R2 via `S3_ENDPOINT`). |
| `person.md` | THE persona. Sent verbatim to the LLM with every request. |

## Environment variables

See `.env.example`. All are required unless noted.

| Variable | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather. |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs allowed to talk to the bot. **Everyone else is silently ignored.** |
| `OPENROUTER_API_KEY` | OpenRouter API key. |
| `OPENROUTER_MODEL` | Model slug, e.g. `anthropic/claude-sonnet-4.5`. Pick a model that follows persona instructions well and supports JSON output. |
| `S3_ENDPOINT` | Optional. Custom S3 endpoint (MinIO/R2). Omit for plain AWS. |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3 credentials and location. |
| `S3_PREFIX` | Optional key prefix inside the bucket. |
| `PORT` | HTTP port (default 3000). |
| `PERSON_TIMEZONE` | IANA timezone of the imitated person (default `Europe/Zurich`). Drives all "what time is it for me" reasoning. |

## Persistent data (S3 layout)

Conversations are kept **per contact** — the imitated person talks to several people, and each relationship has its own history and memory:

```
<S3_PREFIX>/chats/<userId>/chat.jsonl   # last 200 messages of this conversation
<S3_PREFIX>/chats/<userId>/memory.txt   # long-term distilled facts about this contact
<S3_PREFIX>/chats/<userId>/state.json   # pending reply/followup timers (restart survival)
```

- **chat.jsonl** — one JSON object per line: `{"ts": "<ISO>", "from": "them"|"me", "text": "...", "chatId": <n>}`. `appendChat()` in `src/store.js` is the single general function that appends the new message **and deletes the oldest ones past the 200 limit** in the same operation, then persists to S3.
- **memory.txt** — plain text bullet notes written by the LLM about this contact (facts, plans, promises, dates). Because chat.jsonl only holds 200 messages, anything important must be distilled here or it is lost. Updated whenever a reply decision sets `memoryUpdateNeeded: true`.
- **state.json** — `{pendingReply, pendingFollowup}` with due timestamps. On boot, `restorePendingTimers()` re-arms them, so a "reply tomorrow morning" or "check in next week" survives restarts. Timers that became due while the app was down fire after a small random "just picked up my phone" delay instead of instantly.

## LLM contract

Every incoming message triggers one OpenRouter call. The model answers with **only** this JSON object:

```json
{
  "answerNeeded": true,
  "answer": "text — empty if answerNeeded is false; blank lines split it into separate Telegram messages",
  "answerDelay": 420,
  "followup": "always filled — sent only if the contact never replies",
  "followupDelay": 14400,
  "memoryUpdateNeeded": false
}
```

- **answerNeeded** — `false` when a real person would simply not reply (bare "ok", "👍", etc.). A followup is still scheduled.
- **answerDelay** (seconds) — how long the person would realistically take, derived from the profile's reply-behaviour table, the current local time, and the message's length/complexity. Night message → delay carries into wake-up time (e.g. 25200s). Evening banter → 5–60s. Sanitized in code to 2s…14h.
- **followup / followupDelay** — the message sent if the contact stays silent. Minutes-to-hours for an unanswered question ("und?"), days-to-a-week for a fresh check-in after a conversation ended. Sanitized to 5min…14d. **One followup per cycle** — after it fires, the bot waits for the contact (no infinite nagging).
- **memoryUpdateNeeded** — triggers a separate LLM call (`updateMemory`) that rewrites `memory.txt` from the current memory + chat.jsonl.

Sanitization lives in `sanitizeReply()` in `src/llm.js` — adjust the clamps there if the persona needs longer/shorter extremes.

## Timing & debounce semantics

- A **new incoming message cancels** any pending reply and followup, and re-runs the LLM with the full updated history — like a human re-thinking what to say when a second message arrives. A `generation` counter per user also discards LLM responses that were still in flight when a newer message arrived.
- Replies wait silently for `answerDelay`, then show **typing** for a duration proportional to the text length (~4–7 chars/sec, capped at 45s), then send. Multi-paragraph answers are sent as separate burst messages with 0.8–2.5s gaps and their own typing periods.
- Every sent burst is appended to chat.jsonl as `from: "me"`, so the next LLM call sees exactly what was actually said.

## Telegram realism — what is and isn't possible

Managed by the app:
- **Typing indicator** — duration scales with message length, re-sent every 4s to stay visible.
- **Reply timing** — fully LLM-driven per the profile schedule; this is the strongest humanity signal.
- **Message bursts** — humans send 3 short messages, not one essay.
- **Selective silence** — `answerNeeded: false` mimics leaving things on read.
- **Unprompted followups** — the bot initiates contact, which pure request/response bots never do.

Platform limitation: **bot accounts have no online/last-seen status** — Telegram clients simply don't display presence for bots, so there is nothing to fake (and nothing that gives the bot away there). Read receipts (double check) happen implicitly. If true last-seen/online simulation is ever required, the upgrade path is converting `src/telegram.js` to an MTProto **userbot** (a real user account driven by e.g. [gramjs](https://github.com/gram-js/gramjs)); the rest of the codebase (bot.js, llm.js, store.js, humanize.js) is transport-agnostic and would not change.

## Crafting a person.md

`person.md` is injected verbatim into the system prompt of every LLM call. The current file is a complete example persona ("Jonas Berger") — replace it, keeping every section, since the prompt logic leans on them:

1. **Identity** — name, age, city, job, living situation, languages. Concrete > vague.
2. **Personality** — temperament, humour, conversational habits (counter-questions? deflection?).
3. **Hobbies & life** — weekly schedule anchors (training days, match days) that explain unavailability; family/friend names the person would naturally mention.
4. **Texting style** — the most important section for believability. Capitalisation, punctuation, dialect/language, emoji habits (which ones, how often), typical message length, filler words, how typos are handled. Give literal example phrases.
5. **Reply behaviour & availability** — a time-of-day table: sleep window, work blocks, commute, free evenings, weekend differences, recurring events. This is what the LLM uses to compute `answerDelay`. Be specific ("asleep 23:30–07:00, replies ~07:15") not vague ("sleeps at night").
6. **Followup behaviour** — does the person poke when ignored? How fast? How do they resurface after days (link, question about a mentioned plan)?
7. **Hard boundaries** — always include: never admit being an AI (and how to react to accusations), no assistant-style output, no knowledge the person wouldn't have, deflections for media requests (photos/voice) and real-world favours.

Rules of thumb: write it like a briefing for an actor, use literal example messages, prefer tables for schedules, and update it whenever real-life facts change (new job, moved city) — memory.txt covers conversation facts, person.md covers who the person *is*.

## Running

```bash
cp .env.example .env   # fill in real values
npm install
npm start              # or: npm run dev (auto-restart on file changes)
```

Endpoints: `GET /health` (liveness), `GET /status` (per-contact log size, last message time, pending reply/followup due times).

## Operational notes

- Single process, long polling — do **not** run two instances against the same bot token (Telegram getUpdates conflicts) or the same S3 prefix (lost writes).
- All S3 access is write-through with an in-memory cache; external edits to the S3 files while the app runs are not picked up until restart.
- Non-allowed senders are logged and ignored — the bot never reveals it exists to strangers.
- Only private text messages are handled; photos/voice/stickers from contacts are currently invisible to the bot (see suggestions in the project README/issue list for media handling).
