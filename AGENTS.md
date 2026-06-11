# Socrates — Telegram Persona Bot

A Node.js/Express application that wraps OpenRouter and imitates a specific real person over Telegram as convincingly as possible. The bot reads a `person.md` profile, keeps per-contact chat history and long-term memory in S3, and reproduces human texting behaviour: realistic reply delays based on time of day, typing indicators, multi-message bursts, emoji reactions, occasional typo + `*correction`, unprompted followups, silence when a real person wouldn't reply, and understanding of incoming photos and voice notes.

Deployment instructions (Railway) live in [README.md](README.md). This file is the technical reference.

## Architecture

```
Telegram (long polling)
      │ incoming message (text / photo / voice)
      ▼
src/media.js ── photo → description, voice → transcript (OPENROUTER_MEDIA_MODEL)
      │ text representation
      ▼
src/bot.js  ── append to chat.jsonl ──► src/store.js ──► S3 (write-through, in-memory cache)
      │
      ▼
src/llm.js  ── person.md + memory.txt + chat history + current time ──► OpenRouter
      │            returns the JSON decision (see "LLM contract")
      ▼
src/humanize.js ── waits answerDelay, reacts, shows "typing…", sends bursts ──► Telegram
      │
      └── schedules followup (fires only if the contact stays silent;
      │   after firing, the NEXT followup is generated immediately)
      └── if memoryUpdateNeeded: second LLM call distills chat → memory.txt

src/dashboard.js ── password-protected admin UI/API on "/" (Express)
```

### File map

| File | Purpose |
|---|---|
| `src/index.js` | Entrypoint. Express server (`/health`, `/status`, dashboard), boots polling, restores persisted timers, runs the hourly followup guard. |
| `src/config.js` | Loads and validates all env variables. Fails fast on missing ones. Normalizes the S3 endpoint (adds `https://` if missing). |
| `src/telegram.js` | Dependency-free Telegram Bot API client: long polling, `sendMessage`, typing action, `setMessageReaction` (+ allowed-emoji normalization), file download. |
| `src/media.js` | Incoming photos → 1-2 sentence description; voice notes → verbatim transcript. Uses `OPENROUTER_MEDIA_MODEL`. Graceful placeholders on failure. |
| `src/bot.js` | Conversation engine: allow-list check, debounce, reply/reaction/followup scheduling, followup invariant + guard, restart recovery, memory trigger, dashboard operations. |
| `src/llm.js` | OpenRouter wrapper. `generateReply` (the JSON contract), `generateFollowup` (re-engagement planning), `updateMemory` (distillation), raw `chatCompletion`. |
| `src/humanize.js` | Human realism: typing duration ∝ message length, burst splitting, inter-burst pauses, typo + `*correction` (≤1 per send, ~7% chance), long-delay timers. |
| `src/store.js` | Data layer over S3: `chat.jsonl` (append+trim in ONE function), `memory.txt`, `state.json` — all **per contact**. |
| `src/storage.js` | Raw S3 get/put (AWS SDK v3, works with AWS, MinIO, Cloudflare R2, Hetzner via `S3_ENDPOINT`). |
| `src/dashboard.js` | Admin dashboard: login (DASHBOARD_PASSWORD → bearer token), chat viewer, memory editor, pending-action cancel/regenerate, manual send. Single-file HTML UI, no build step. |
| `person.md` | THE persona. Sent verbatim to the LLM with every request. |

## Environment variables

See `.env.example`. All are required unless noted.

| Variable | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather. |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs allowed to talk to the bot. **Everyone else is silently ignored.** |
| `OPENROUTER_API_KEY` | OpenRouter API key. |
| `OPENROUTER_MODEL` | Main model slug. Pick one that follows persona instructions well and supports JSON output. |
| `OPENROUTER_MEDIA_MODEL` | Optional. Vision **and** audio capable model for photo description / voice transcription (recommended: `google/gemini-2.5-flash`). Defaults to `OPENROUTER_MODEL`. |
| `S3_ENDPOINT` | Optional. Custom S3 endpoint (MinIO/R2/Hetzner). With or without `https://`. Omit for plain AWS. |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3 credentials and location. |
| `S3_PREFIX` | Optional key prefix inside the bucket. |
| `DASHBOARD_PASSWORD` | Password for the admin dashboard at `/`. If unset, the dashboard is **disabled**. |
| `PORT` | HTTP port (default 3000; injected by Railway). |
| `PERSON_TIMEZONE` | IANA timezone of the imitated person (default `Europe/Zurich`). Drives all "what time is it for me" reasoning. |

## Persistent data (S3 layout)

Conversations are kept **strictly per contact** — the imitated person talks to several people, and each relationship has its own history, memory and timers. Nothing is shared between contacts:

```
<S3_PREFIX>/chats/<userId>/chat.jsonl   # last 200 messages of this conversation
<S3_PREFIX>/chats/<userId>/memory.txt   # long-term distilled facts about this contact
<S3_PREFIX>/chats/<userId>/state.json   # pending reply/followup timers (restart survival)
```

- **chat.jsonl** — one JSON object per line: `{"ts": "<ISO>", "from": "them"|"me", "text": "...", "chatId": <n>}` (reaction log entries additionally carry `"type": "reaction"`). Incoming media appears as text: `[sent a photo: …]` / `[sent a voice message, 12s: "…"]`. `appendChat()` in `src/store.js` is the single general function that appends the new message **and deletes the oldest ones past the 200 limit** in the same operation, then persists to S3.
- **memory.txt** — plain text bullet notes written by the LLM about this contact (facts, plans, promises, dates). Because chat.jsonl only holds 200 messages, anything important must be distilled here or it is lost. Updated whenever a reply decision sets `memoryUpdateNeeded: true`, or manually via the dashboard.
- **state.json** — `{pendingReply, pendingFollowup, chatId}` with due timestamps. On boot, `restorePendingTimers()` re-arms them, so a "reply tomorrow morning" or "check in next week" survives restarts. Timers that became due while the app was down fire after a small random "just picked up my phone" delay instead of instantly.

## LLM contract

Every incoming message triggers one OpenRouter call. The model answers with **only** this JSON object:

```json
{
  "answerNeeded": true,
  "answer": "text — empty if answerNeeded is false; blank lines split it into separate Telegram messages",
  "answerDelay": 420,
  "reaction": "👍",
  "followup": "always filled — sent only if the contact never replies",
  "followupDelay": 14400,
  "memoryUpdateNeeded": false
}
```

- **answerNeeded** — `false` when a real person would simply not reply (bare "ok", "👍", etc.). A followup is still scheduled.
- **answerDelay** (seconds) — when the person would realistically *see and handle* the message, derived from the profile's reply-behaviour table, the current local time, and the message's length/complexity. Night message → delay carries into wake-up time (e.g. 25200s). Evening banter → 5–60s. Sanitized in code to 2s…14h, with ±12% jitter so delays never form a statistical fingerprint.
- **reaction** — optional emoji reaction to the incoming message (Telegram's reaction feature), applied at `answerDelay` time just before typing starts. Normalized against Telegram's fixed allowed-reaction set in `src/telegram.js` (`❤️→❤`, `😂→🤣`, invalid → dropped). Reaction-only responses (react, no text) are fully supported.
- **followup / followupDelay** — the message sent if the contact stays silent. Minutes-to-hours for an unanswered question ("und?"), days-to-a-week for a fresh check-in after a conversation ended. Sanitized to 5min…14d.
- **memoryUpdateNeeded** — triggers a separate LLM call (`updateMemory`) that rewrites `memory.txt` from the current memory + chat.jsonl.

Sanitization lives in `sanitizeReply()` in `src/llm.js` — adjust the clamps there if the persona needs longer/shorter extremes.

## The followup invariant

**Every contact with chat history always has exactly one pending followup.** This is what makes the persona initiate contact like a real friend instead of only ever responding:

1. Every reply decision carries a followup → scheduled when the reply is sent.
2. When a followup fires (contact stayed silent), `chainNextFollowup()` immediately asks the LLM (`generateFollowup`) to plan the *next* re-engagement message — scheduled, never sent directly. The LLM sees the run of consecutive unanswered `YOU:` messages in the history and is instructed to space messages out further and change topic rather than nag, and to land them at hours the persona would plausibly be on the phone.
3. A **guard tick** (90s after boot, then hourly) backfills a followup for any contact that has neither a pending reply nor a pending followup (e.g. after an LLM error or legacy state). It only *schedules* — nothing is ever sent on the hour, so nothing feels cron-like.
4. Any incoming message from the contact cancels the pending followup instantly; the normal reply pipeline takes over and produces a fresh one.

Contacts with zero chat history are never cold-opened by the guard.

## Timing & debounce semantics

- A **new incoming message cancels** any pending reply and followup, and re-runs the LLM with the full updated history — like a human re-thinking what to say when a second message arrives. A `generation` counter per user also discards LLM responses (and followup chains) that were still in flight when a newer message arrived.
- Replies wait silently for `answerDelay`, then (optionally) react, then show **typing** for a duration proportional to the text length (~4–7 chars/sec, capped at 45s), then send. Multi-paragraph answers are sent as separate burst messages with 0.8–2.5s gaps and their own typing periods.
- ~7% of sends introduce one realistic adjacent-letter typo in a word, followed 1.5–5s later by the classic `*correctword` message. At most one typo per send.
- Every sent burst (including corrections and reactions) is appended to chat.jsonl as `from: "me"`, so the next LLM call sees exactly what was actually said.

## Media handling

`src/media.js` converts incoming media to text before anything else touches it:

- **Photos** — downloaded via the Bot API, sent base64 to `OPENROUTER_MEDIA_MODEL` as `image_url`, described in 1-2 sentences (including visible text). Captions are preserved. Stored as `[sent a photo (caption: "…"): description]`.
- **Voice notes** — downloaded and sent as `input_audio` (ogg/opus as Telegram delivers it) for verbatim transcription. Stored as `[sent a voice message, 12s: "transcript"]`. Gemini models handle ogg audio; if the media model can't, the graceful fallback is stored instead — `[… could not be listened to right now]` — and the persona deflects like a human who couldn't listen ("bin grad ungerwegs, lose spöter").

The reply prompt tells the model these bracketed lines describe media, so the persona reacts to the *content* naturally.

## Dashboard

Enabled when `DASHBOARD_PASSWORD` is set; served at `/`. Login exchanges the password for an in-memory bearer token (restart = re-login). Features per contact:

- **Chat** — full chat.jsonl rendered as bubbles; manual send box (message goes out human-like with typing and bursts, and is logged as `me`).
- **Pending** — inspect the queued reply (text/reaction + due time) and followup; cancel either; regenerate the followup on demand.
- **Memory** — view and edit memory.txt directly, or trigger a fresh distillation from the chat.

JSON API under `/api/*` (same token): `POST /api/login`, `GET /api/contacts`, `GET/PUT /api/contacts/:id/memory`, `GET /api/contacts/:id/chat`, `POST /api/contacts/:id/send|cancel|regenerate-followup|update-memory`.

## Telegram realism — what is and isn't possible

Managed by the app:
- **Typing indicator** — duration scales with message length, re-sent every 4s to stay visible.
- **Reply timing** — fully LLM-driven per the profile schedule; this is the strongest humanity signal.
- **Message bursts** — humans send 3 short messages, not one essay.
- **Emoji reactions** — react instead of (or before) replying.
- **Typos + `*corrections`** — rare, human, and never twice in a row.
- **Selective silence** — `answerNeeded: false` mimics leaving things on read.
- **Unprompted followups** — the bot initiates contact, which pure request/response bots never do.

Platform limitation: **bot accounts have no online/last-seen status** — Telegram clients simply don't display presence for bots, so there is nothing to fake (and nothing that gives the bot away there). Read receipts (double check) happen implicitly. If true last-seen/online simulation is ever required, the upgrade path is converting `src/telegram.js` to an MTProto **userbot** (a real user account driven by e.g. [gramjs](https://github.com/gram-js/gramjs)); the rest of the codebase (bot.js, llm.js, store.js, humanize.js, media.js) is transport-agnostic and would not change.

## Crafting a person.md

`person.md` is injected verbatim into the system prompt of every LLM call. The current file is a complete example persona ("Jonas Berger") — replace it, keeping every section, since the prompt logic leans on them:

1. **Identity** — name, age, city, job, living situation, languages. Concrete > vague.
2. **Personality** — temperament, humour, conversational habits (counter-questions? deflection?).
3. **Hobbies & life** — weekly schedule anchors (training days, match days) that explain unavailability; family/friend names the person would naturally mention.
4. **Texting style** — the most important section for believability. Capitalisation, punctuation, dialect/language, emoji habits (which ones, how often), reaction habits (which emojis they tap on messages), typical message length, filler words, how typos are handled. Give literal example phrases.
5. **Reply behaviour & availability** — a time-of-day table: sleep window, work blocks, commute, free evenings, weekend differences, recurring events. This is what the LLM uses to compute `answerDelay`. Be specific ("asleep 23:30–07:00, replies ~07:15") not vague ("sleeps at night").
6. **Followup behaviour** — does the person poke when ignored? How fast? How do they resurface after days (link, question about a mentioned plan)?
7. **Hard boundaries** — always include: never admit being an AI (and how to react to accusations), no assistant-style output, no knowledge the person wouldn't have, deflections for media requests (photos/voice) and real-world favours.

Rules of thumb: write it like a briefing for an actor, use literal example messages, prefer tables for schedules, and update it whenever real-life facts change (new job, moved city) — memory.txt covers conversation facts, person.md covers who the person *is*. The file is read once at boot; redeploy/restart after editing.

## Running

```bash
cp .env.example .env   # fill in real values
npm install
npm start              # or: npm run dev (auto-restart on file changes)
```

Endpoints: `GET /health` (liveness), `GET /status` (per-contact summary), `/` (dashboard, if enabled). Railway deployment: see README.md.

## Operational notes

- Single process, long polling — do **not** run two instances against the same bot token (Telegram getUpdates conflicts) or the same S3 prefix (lost writes). On Railway: exactly 1 replica, never-sleeping plan.
- All S3 access is write-through with an in-memory cache; external edits to the S3 files while the app runs are not picked up until restart (use the dashboard's memory editor instead — it writes through the cache).
- Non-allowed senders are logged and ignored — the bot never reveals it exists to strangers.
- Private text, photo and voice messages are handled; stickers/video/documents are currently ignored.
