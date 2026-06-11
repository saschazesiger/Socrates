# Socrates — Telegram Persona Bot

A Node.js/Express application that wraps OpenRouter and imitates a specific real person over Telegram as convincingly as possible. It drives a **real Telegram user account** — an MTProto **userbot** via [gramjs](https://github.com/gram-js/gramjs), not a Bot API bot — which is what lets it manage genuine online/last-seen presence and real read receipts. It reads a `person.md` profile, keeps per-contact chat history and long-term memory in S3, and reproduces human texting behaviour: realistic reply delays based on time of day, online-status management, controlled read receipts, typing indicators, multi-message bursts, emoji reactions, occasional typo + `*correction`, unprompted followups, silence when a real person wouldn't reply, and understanding of incoming photos and voice notes.

Deployment instructions (Railway, plus the one-time `npm run login` to mint a session) live in [README.md](README.md). This file is the technical reference.

## Architecture

```
Telegram user account (gramjs / MTProto, real account)
      │ incoming message (text / photo / voice) — DELIVERED, not yet read
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
src/humanize.js ── at answerDelay: come ONLINE, mark READ, react,
      │            show "typing…", send bursts ──► Telegram, then go offline
      │
      └── schedules followup (fires only if the contact stays silent;
      │   after firing, the NEXT followup is generated immediately)
      └── if memoryUpdateNeeded: second LLM call distills chat → memory.txt

src/dashboard.js ── password-protected admin UI/API on "/" (Express):
      │            Contacts · Settings · Connection (Telegram login from browser)
src/settings.js ── runtime config in S3 (settings.json): session, allowed
      │            accounts/allow-all, model + media model, behaviour knobs, pause
scripts/login.mjs ── optional one-time interactive login → prints TELEGRAM_SESSION
```

### File map

| File | Purpose |
|---|---|
| `src/index.js` | Entrypoint. Express server (`/health`, `/status`, dashboard), connects the userbot, restores persisted timers, runs the hourly followup guard. |
| `src/config.js` | Loads and validates env variables. Fails fast on missing **required** ones (API id/hash, OpenRouter key, S3, dashboard password). The session / allow-list / model vars are now optional and only **seed** `settings.json`. Normalizes the S3 endpoint. |
| `src/settings.js` | Runtime configuration stored in S3 as `settings.json` (write-through cache), editable live from the dashboard: `session`, `allowedUserIds`, `allowAll`, `model`, `mediaModel`, and a `behavior` block (typing speed, typo rate, burst gaps, online linger, delay jitter/clamps, reply temperature, global `paused`). Seeded from env on first boot. Exposes `getSettings`/`updateSettings`/`isAllowed`/`redactedSettings`. |
| `src/telegram.js` | gramjs **MTProto userbot** client: connect/auth via StringSession (read from `settings.json`), incoming-message normalization, `sendMessage`, typing action, emoji reactions (+ normalization), **presence (`setOnline`)**, **read receipts (`markRead`)**, media download. Also: the **browser login flow** (`loginStart`/`loginCode`/`loginPassword` → phone, code, 2FA), live `restart()` after a session change, `connectionStatus()`, and best-effort contact-name resolution for the dashboard. Peers handled as serializable `{ id, accessHash }` descriptors. |
| `scripts/login.mjs` | One-time interactive login (`npm run login`): phone + code + 2FA → prints the `TELEGRAM_SESSION` StringSession. Standalone; needs only `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`. |
| `src/media.js` | Incoming photos → 1-2 sentence description; voice notes → verbatim transcript (downloaded via gramjs `downloadMedia`). Uses the media model from `settings.json` (falls back to the main model). Graceful placeholders on failure. |
| `src/bot.js` | Conversation engine: allow-list check (settings-driven), debounce, reply/reaction/followup scheduling, followup invariant + guard, restart recovery, memory trigger, global pause, dynamic contact discovery, and the dashboard operations (edit/send-now/cancel/regenerate/prune). |
| `src/llm.js` | OpenRouter wrapper. `generateReply` (the JSON contract), `generateFollowup` (re-engagement planning), `updateMemory` (distillation), raw `chatCompletion`, and `listModels` (catalogue for the dashboard picker). Model + temperature + delay clamps come from `settings.json`. |
| `src/humanize.js` | Human realism: typing duration ∝ message length, burst splitting, inter-burst pauses, typo + `*correction`, long-delay timers — all tunable live via `settings.json` behaviour knobs. |
| `src/store.js` | Data layer over S3: `chat.jsonl` (append+trim in ONE function), `memory.txt`, `state.json` — all **per contact** — plus contact discovery (`listContactIds`) and pruning (`resetContact`). |
| `src/storage.js` | Raw S3 get/put/**delete/list** (AWS SDK v3, works with AWS, MinIO, Cloudflare R2, Hetzner via `S3_ENDPOINT`). |
| `src/dashboard.js` | Admin dashboard (single-file HTML UI, no build step): login (DASHBOARD_PASSWORD → bearer token). **Contacts** (chat viewer, memory editor, pending reply/followup cancel·edit·send-now·regenerate, manual send, prune chat/memory/state). **Settings** (allowed accounts / allow-all, model + media-model picker from OpenRouter's catalogue, behaviour knobs, global pause). **Connection** (userbot status + phone→code→2FA login that persists the session and restarts the client). |
| `person.md` | THE persona. Sent verbatim to the LLM with every request. |

## Environment variables

See `.env.example`. Required unless marked optional. Four formerly-required vars
(`TELEGRAM_SESSION`, `ALLOWED_USER_IDS`, `OPENROUTER_MODEL`, `OPENROUTER_MEDIA_MODEL`)
are now **runtime settings** held in `settings.json` and edited from the dashboard;
if set in the env they only **seed** `settings.json` on first boot.

| Variable | Meaning |
|---|---|
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | **Required.** MTProto app credentials from https://my.telegram.org → API development tools. Identify the *app*, not the account. |
| `OPENROUTER_API_KEY` | **Required.** OpenRouter API key. |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | **Required.** S3 credentials and location. |
| `S3_ENDPOINT` | Optional. Custom S3 endpoint (MinIO/R2/Hetzner). With or without `https://`. Omit for plain AWS. |
| `S3_PREFIX` | Optional key prefix inside the bucket. |
| `DASHBOARD_PASSWORD` | **Required in practice.** Password for the dashboard at `/`. If unset, the dashboard is **disabled** — and with it the only way to log in / change settings without env vars. |
| `PORT` | HTTP port (default 3000; injected by Railway). |
| `PERSON_TIMEZONE` | IANA timezone of the imitated person (default `Europe/Zurich`). Drives all "what time is it for me" reasoning. |
| `TELEGRAM_SESSION` | **Optional / seed.** gramjs StringSession (full account access — secret). Normally minted from the dashboard → Connection; `npm run login` still works. Stored in `settings.json` thereafter. |
| `ALLOWED_USER_IDS` | **Optional / seed.** Comma-separated Telegram user IDs. The live allow-list (and an "allow everyone" toggle) is edited in the dashboard → Settings. |
| `OPENROUTER_MODEL` | **Optional / seed.** Main model slug (must follow persona instructions + support JSON output). Selected in the dashboard → Settings. |
| `OPENROUTER_MEDIA_MODEL` | **Optional / seed.** Vision **and** audio capable model for photos/voice (e.g. `google/gemini-2.5-flash`). Falls back to the main model. |

## Runtime settings (`settings.json`)

Everything an operator changes without a redeploy lives in one S3 object,
`<S3_PREFIX>/settings.json`, owned by `src/settings.js` (write-through cache).
On first boot it is **seeded from the env vars** above; after that the dashboard
is the source of truth and the env values are ignored.

```jsonc
{
  "session": "<TELEGRAM StringSession>",   // minted via dashboard login (secret)
  "allowedUserIds": ["11111111"],          // who the persona talks to …
  "allowAll": false,                        // … unless this is true (reply to anyone)
  "model": "deepseek/deepseek-v4-flash",   // main model (replies, memory)
  "mediaModel": "google/gemini-2.5-flash", // vision+audio (falls back to model)
  "behavior": {
    "paused": false,                        // global kill-switch (auto sends held)
    "typoProbability": 0.07,
    "typingCharsPerSecMin": 4, "typingCharsPerSecMax": 7, "typingMaxSeconds": 45,
    "burstGapMinMs": 800, "burstGapMaxMs": 2500,
    "onlineLingerMinMs": 5000, "onlineLingerMaxMs": 30000,
    "activeChatWindowSeconds": 180, "activeChatMaxReplySeconds": 90,
    "answerDelayJitter": 0.12,
    "minAnswerDelaySeconds": 2, "maxAnswerDelaySeconds": 50400,
    "replyTemperature": 0.9
  }
}
```

- **session** — read by `telegram.js` `getClient()`. Changing it (dashboard login or logout) calls `restart()`, which tears down the MTProto connection and reconnects with the new session, re-using the same message handler. The userbot start is **non-fatal** when no session is authorised yet, so the HTTP server + dashboard stay up for the login flow.
- **allowedUserIds / allowAll** — checked by `isAllowed()` on every incoming message. With `allowAll`, contacts the persona has never been configured for are discovered dynamically by listing S3 (`store.listContactIds`), so they still appear in the dashboard and get followups/restored timers.
- **model / mediaModel** — resolved in `llm.chatCompletion` and `media.js`. The dashboard model picker is populated from OpenRouter's live `/models` catalogue (`llm.listModels`), with a free-text fallback for any slug.
- **behavior** — read live by `humanize.js` (typing/typo/bursts), `bot.js` (online linger, pause, active-chat read-now), and `llm.js` (delay jitter/clamps, active-chat detection, reply temperature). `paused` holds scheduled replies/followups (re-checked every 30s) without dropping them; manual dashboard sends still go out. `activeChatWindowSeconds`/`activeChatMaxReplySeconds` define the "still on the phone" mode (see Timing & presence below).

## Persistent data (S3 layout)

Conversations are kept **strictly per contact** — the imitated person talks to several people, and each relationship has its own history, memory and timers. Nothing is shared between contacts:

```
<S3_PREFIX>/settings.json               # runtime config (session, accounts, models, behaviour)
<S3_PREFIX>/chats/<userId>/chat.jsonl   # last 200 messages of this conversation
<S3_PREFIX>/chats/<userId>/memory.txt   # long-term distilled facts about this contact
<S3_PREFIX>/chats/<userId>/state.json   # pending reply/followup timers (restart survival)
```

- **chat.jsonl** — one JSON object per line: `{"ts": "<ISO>", "from": "them"|"me", "text": "...", "chatId": {id, accessHash}}` (reaction log entries additionally carry `"type": "reaction"`). `chatId` is the serializable peer descriptor (see below). Incoming media appears as text: `[sent a photo: …]` / `[sent a voice message, 12s: "…"]`. `appendChat()` in `src/store.js` is the single general function that appends the new message **and deletes the oldest ones past the 200 limit** in the same operation, then persists to S3.
- **memory.txt** — plain text bullet notes written by the LLM about this contact (facts, plans, promises, dates). Because chat.jsonl only holds 200 messages, anything important must be distilled here or it is lost. Updated whenever a reply decision sets `memoryUpdateNeeded: true`, or manually via the dashboard.
- **state.json** — `{pendingReply, pendingFollowup, chatId}` with due timestamps. On boot, `restorePendingTimers()` re-arms them, so a "reply tomorrow morning" or "check in next week" survives restarts. Timers that became due while the app was down fire after a small random "just picked up my phone" delay instead of instantly.

**Peer descriptor.** The userbot identifies a contact by `{ id, accessHash }` (both strings) — everything the app calls "chatId" is this object. It is built from the incoming message's `getInputSender()` and stored verbatim in S3, so the app can send a followup days later (or after a restart) by rebuilding an `Api.InputPeerUser` without re-resolving the entity. This replaces the Bot API's plain numeric chat id + `file_id` model.

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
- **answerDelay** (seconds) — when the person would realistically *see and handle* the message, derived from the profile's reply-behaviour table, the current local time, and the message's length/complexity. Night message → delay carries into wake-up time (e.g. 25200s). Evening banter → 5–60s. Sanitized in code to 2s…14h, with ±12% jitter so delays never form a statistical fingerprint. **Active conversation:** every reply call includes a plain-language presence note ("you sent your last message 30 seconds ago, and your status shows ONLINE") so the model never has to do timestamp math; when the persona is online or wrote within `activeChatWindowSeconds`, the instructions override the schedule table (reply in seconds) and the delay is additionally hard-capped at `activeChatMaxReplySeconds`.
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

## Timing, presence & debounce semantics

- A message arrives **delivered but unread**. The persona does not read it on arrival — the read receipt only appears at the scheduled "seen" moment (see below), producing a realistic *delivered → read later → typing → reply* sequence.
- A **new incoming message cancels** any pending reply and followup, and re-runs the LLM with the full updated history — like a human re-thinking what to say when a second message arrives. A `generation` counter per user also discards LLM responses (and followup chains) that were still in flight when a newer message arrived.
- **Everything is scheduled at `answerDelay`** via one unified "seen" path (`fireReply`), even a pure silent read (empty text, no reaction). At that moment the persona: comes **online** (`setOnline(true)`), **marks the message read** (`markRead`), optionally **reacts**, optionally **types and replies**, then **lingers online 5–30s and goes offline**. So even "leaving it on read" is modelled: the read receipt shows up `answerDelay` after delivery with no reply.
- Replies show **typing** for a duration proportional to the text length (~4–7 chars/sec, capped at 45s), then send. Multi-paragraph answers are sent as separate burst messages with 0.8–2.5s gaps and their own typing periods.
- **Presence is interaction-scoped.** The account is offline by default and only goes online while actively reading/typing/sending (replies, followups, and dashboard manual sends). A per-user offline timer (reset on each action) drops it back offline shortly after, so it never looks permanently online.
- **Active conversation ("still on the phone").** When a message arrives while the persona is visibly online, or within `activeChatWindowSeconds` of its own last message, the reply call is flagged as mid-conversation: the LLM is told its live presence, instructed to ignore the schedule table, and the chosen delay is hard-capped at `activeChatMaxReplySeconds`. If the persona is online and the reply is due in moments, it *stays* online and marks the message read immediately (chat open, instant read receipt) instead of dropping offline mid-exchange — so rapid back-and-forth produces one continuous online session that ends shortly after the last message.
- ~7% of sends introduce one realistic adjacent-letter typo in a word, followed 1.5–5s later by the classic `*correctword` message. At most one typo per send.
- Every sent burst (including corrections and reactions) is appended to chat.jsonl as `from: "me"`, so the next LLM call sees exactly what was actually said.

## Media handling

`src/media.js` converts incoming media to text before anything else touches it:

- **Photos** — downloaded via gramjs `downloadMedia`, sent base64 to the configured media model (`settings.mediaModel`) as `image_url`, described in 1-2 sentences (including visible text). Captions (which live in `message.message` for MTProto media) are preserved. Stored as `[sent a photo (caption: "…"): description]`.
- **Voice notes** — downloaded via `downloadMedia` and sent as `input_audio` (ogg/opus as Telegram delivers it) for verbatim transcription. Stored as `[sent a voice message, 12s: "transcript"]`. Gemini models handle ogg audio; if the media model can't, the graceful fallback is stored instead — `[… could not be listened to right now]` — and the persona deflects like a human who couldn't listen ("i listen later la, on the train now").

The reply prompt tells the model these bracketed lines describe media, so the persona reacts to the *content* naturally.

## Dashboard

Enabled when `DASHBOARD_PASSWORD` is set; served at `/`. Login exchanges the password for an in-memory bearer token (restart = re-login). Three sections, switched from the left nav; the header always shows connection status, the live/paused state (one-click toggle), and the active model.

**Contacts** — per-contact tabs:
- **Chat** — full chat.jsonl rendered as bubbles (reactions shown distinctly); manual send box (goes out human-like with typing and bursts, logged as `me`).
- **Pending** — inspect the queued reply (editable text + reaction) and followup (editable text); **Save** (re-arms the timer at the same due time), **Send now** (fires immediately, ignoring pause), **Cancel**, and **Regenerate** the followup.
- **Memory** — view/edit memory.txt directly, or trigger a fresh distillation from the chat.
- **Reset** — prune this contact's **chat history**, **memory**, or do a **full wipe** (chat + memory + timers) to start the conversation from scratch.

**Settings** — writes `settings.json`:
- **Allowed contacts** — add/remove user IDs, or flip **allow everyone**.
- **Models** — pick the main and media models from the OpenRouter catalogue, or type any slug.
- **Behaviour** — every humanisation knob (typo rate, typing speed, burst gaps, online linger, delay jitter/clamps, reply temperature) plus the global **pause** kill-switch.

**Connection** — live userbot status (authorised / as whom) and the full login flow: phone number → the code Telegram sends → the 2FA password if the account has one. On success the session is saved to `settings.json` and the client reconnects. Also: **Restart connection** and **Log out** (clears the session).

JSON API under `/api/*` (same bearer token):
- Overview/config: `GET /api/stats`, `GET/PUT /api/settings`, `GET /api/models`.
- Connection: `GET /api/connection`, `POST /api/connection/login/start|code|password`, `POST /api/connection/restart|logout`.
- Contacts: `GET /api/contacts`, `GET /api/contacts/:id/chat`, `GET/PUT /api/contacts/:id/memory`, `POST /api/contacts/:id/send|cancel|regenerate-followup|update-memory|reset`, `POST /api/contacts/:id/reply/edit|send-now`, `POST /api/contacts/:id/followup/edit|send-now`.

A login flow uses a **separate throwaway gramjs client** per attempt so it never disturbs the running userbot connection; on success its `StringSession` is what gets persisted.

## Telegram realism — what the userbot makes possible

Because Socrates drives a **real user account** (not a Bot API bot), the strongest humanity signals — which a bot account literally cannot produce — are available and actively managed:

- **Online / last-seen status** — the account appears online only while reading/typing/sending, then goes offline (`src/telegram.js` `setOnline`, scheduled in `src/bot.js`). Contacts see a believable presence pattern that matches the persona's schedule, not a 24/7 green dot and not the permanent "no presence" of a bot.
- **Real read receipts** — `markRead` is called at the persona's "seen" moment, so messages stay on a single check (delivered) until the persona would actually notice them, then flip to read. "Read but not answered" is a deliberate, human state here.
- **No bot badge** — it's a normal account; no "bot" label, works in any normal private chat, full user feature set.

Also managed by the app (would work on a bot too, but matter just as much):
- **Typing indicator** — duration scales with message length, re-sent every 4s to stay visible.
- **Reply timing** — fully LLM-driven per the profile schedule; the single biggest humanity signal.
- **Message bursts** — humans send 3 short messages, not one essay.
- **Emoji reactions** — react instead of (or before) replying.
- **Typos + `*corrections`** — rare, human, and never twice in a row.
- **Selective silence** — `answerNeeded: false` mimics leaving things on read (with a real read receipt, per above).
- **Unprompted followups** — the account initiates contact, which pure request/response bots never do.

Transport boundary: only `src/telegram.js` (and the `scripts/login.mjs` helper) know about gramjs/MTProto. `bot.js`, `llm.js`, `store.js`, `humanize.js` and `media.js` are transport-agnostic — they deal in the normalized message shape and the `{ id, accessHash }` peer descriptor, so swapping transports again would touch only that one file.

Operational caveat of using a real account: automating a user account is against Telegram's terms if abused (spam/mass-messaging) and can get the account limited or banned. Keep volume conversational; use a dedicated number the persona owns. A login may need re-minting (`npm run login`) if the session is revoked.

## Crafting a person.md

`person.md` is injected verbatim into the system prompt of every LLM call. The current file is a complete example persona ("Jonas Berger") — replace it, keeping every section, since the prompt logic leans on them:

1. **Identity** — name, age, city, job, living situation, languages. Concrete > vague.
2. **Personality** — temperament, humour, conversational habits (counter-questions? deflection?).
3. **Hobbies & life** — weekly schedule anchors (training days, match days) that explain unavailability; family/friend names the person would naturally mention.
4. **Texting style** — the most important section for believability. Capitalisation, punctuation, dialect/language, emoji habits (which ones, how often), reaction habits (which emojis they tap on messages), typical message length, filler words, how typos are handled. Give literal example phrases.
5. **Reply behaviour & availability** — a time-of-day table: sleep window, work blocks, commute, free evenings, weekend differences, recurring events. This is what the LLM uses to compute `answerDelay`. Be specific ("asleep 23:30–07:00, replies ~07:15") not vague ("sleeps at night"). Include an active-conversation bullet ("if he wrote in the chat moments ago he's still on the phone and replies in seconds") so the profile agrees with the built-in active-chat override.
6. **Followup behaviour** — does the person poke when ignored? How fast? How do they resurface after days (link, question about a mentioned plan)?
7. **Hard boundaries** — always include: never admit being an AI (and how to react to accusations), no assistant-style output, no knowledge the person wouldn't have, deflections for media requests (photos/voice) and real-world favours.

Rules of thumb: write it like a briefing for an actor, use literal example messages, prefer tables for schedules, and update it whenever real-life facts change (new job, moved city) — memory.txt covers conversation facts, person.md covers who the person *is*. The file is read once at boot; redeploy/restart after editing.

## Running

```bash
cp .env.example .env   # fill in TELEGRAM_API_ID / TELEGRAM_API_HASH first
npm install
npm run login          # one-time: prints TELEGRAM_SESSION → paste into .env
npm start              # or: npm run dev (auto-restart on file changes)
```

Endpoints: `GET /health` (liveness), `GET /status` (per-contact summary), `/` (dashboard, if enabled). Railway deployment: see README.md.

## Operational notes

- Single process, single MTProto connection — do **not** run two instances with the same `TELEGRAM_SESSION` (the account would be logged in twice and double-send) or against the same S3 prefix (lost writes). On Railway: exactly 1 replica, never-sleeping plan.
- The `TELEGRAM_SESSION` is full account access — keep it secret, never commit it. Revoking active sessions in Telegram (Settings → Devices) invalidates it; re-mint with `npm run login`.
- All S3 access is write-through with an in-memory cache; external edits to the S3 files while the app runs are not picked up until restart (use the dashboard's memory editor instead — it writes through the cache).
- Non-allowed senders are logged and ignored — the persona never reveals it exists to strangers.
- Private text, photo and voice messages are handled; stickers/video/documents are currently ignored.
- Automating a real account carries Telegram ToS / ban risk if used abusively — keep it low-volume and conversational; prefer a dedicated number.
