# Socrates — Telegram Persona Bot

A Node.js app that imitates a real person over Telegram. It drives a **real Telegram user account** (an MTProto userbot via [gramjs](https://github.com/gram-js/gramjs) — not a Bot API bot), wraps any [OpenRouter](https://openrouter.ai) model with a persona defined in [`person.md`](person.md), and reproduces real human texting behaviour:

- **Real account, real presence** — because it's a user account, not a bot, it has a genuine **online / last-seen status** that the app manages (the persona comes online only while reading/typing, then goes offline), **real read receipts** it controls (messages show "read" when the persona actually notices them, not on delivery), and no "bot" badge anywhere.
- **Realistic reply timing** — the LLM decides how long "you" would take to answer, based on the persona's daily schedule (asleep at night → reply next morning; at work → an hour; evening banter → seconds). And it knows its own presence: if the persona wrote seconds ago or still shows online, it's mid-conversation — it stays online, reads immediately, and answers within seconds instead of falling back to the schedule.
- **Typing indicator & message bursts** — typing duration scales with message length; long answers arrive as several short messages, like real texting.
- **Reactions & typos** — occasionally reacts with 👍/🤣 instead of replying, and rarely sends a typo followed by the classic `*correction`.
- **Selective silence** — leaves "ok"-type messages on read, like a person would.
- **Always a followup planned** — if the contact goes quiet, the persona naturally re-engages later ("how did the interview go?"). There is *always* exactly one upcoming followup scheduled per contact; it's discarded the moment they reply.
- **Photos & voice notes** — incoming photos are described and voice messages transcribed via a vision/audio-capable model, so the persona reacts to their content.
- **Long-term memory** — chat history keeps the last 200 messages per contact (`chat.jsonl`); important facts are distilled into a per-contact `memory.txt` so nothing is lost.
- **Admin dashboard** — password-protected web UI that is now the control center for the whole bot:
  - **Contacts** — inspect conversations, edit memory, cancel/**edit**/**send-now**/regenerate pending reply & followup, send manual messages as the persona, and **prune** a contact's chat / memory / timers to start that conversation from scratch.
  - **Settings** — manage the **allowed accounts** (or flip on **allow-everyone**), pick the **main and media models** (from the live OpenRouter catalogue), tune the **humanisation knobs** (typing speed, typo rate, burst gaps, online linger, active-chat window, delay jitter/clamps), and flip a global **pause** kill-switch — all without a redeploy.
  - **Connection** — see live userbot status and **log the persona's account in from the browser** (phone → code → 2FA), minting and persisting the Telegram session with no env var or local `npm run login`.

Everything persists to S3-compatible storage, so the app itself is stateless and survives restarts/redeploys — including "reply tomorrow at 7am" timers. Runtime configuration (the Telegram session, allowed accounts, model choice, and behaviour knobs) lives in a single `settings.json` in the same bucket and is edited entirely from the dashboard — so a fresh deploy can be authorised and tuned without touching environment variables.

> ⚠️ This runs an **automated real account**. Telegram's terms restrict abusive automation (spam, mass-messaging, etc.); a normal, low-volume personal conversation is what this is built for. Use an account you control and only with people you're allowed to talk to. See [responsible use](#a-note-on-responsible-use).

> Full technical documentation (architecture, data layout, LLM contract, how to write a `person.md`) lives in [AGENTS.md](AGENTS.md).

## Prerequisites

1. **A Telegram account for the persona** — ideally a dedicated account (its own SIM/number) that *is* the persona, with a real-sounding name and profile photo. The app logs in **as this account**.
2. **Telegram API credentials** — sign in at [my.telegram.org](https://my.telegram.org) → **API development tools** → create an app → copy `api_id` and `api_hash`. These identify your *app*, not the account.
3. **A login session string** — run `npm run login` locally once (see [Generate the session](#1-generate-the-session-string-once-locally)); it logs the account in (phone + code + 2FA) and prints a `TELEGRAM_SESSION` string. The session is what the deployed app uses — no phone code needed again.
4. **Your contacts' Telegram user IDs** — each allowed person can get theirs from [@userinfobot](https://t.me/userinfobot). Everyone else is silently ignored.
5. **OpenRouter account** — API key from [openrouter.ai/keys](https://openrouter.ai/keys). Pick a main model that's good at persona instructions + JSON output, and a media model that supports vision *and* audio (e.g. `google/gemini-2.5-flash`) for photos/voice.
6. **S3-compatible bucket** — AWS S3, Cloudflare R2, Hetzner Object Storage, MinIO… anything with the S3 API.
7. **A `person.md`** — edit the one in this repo. It ships as a complete example persona; the believability of the whole thing depends on this file. See [AGENTS.md → Crafting a person.md](AGENTS.md#crafting-a-personmd).

## Deploy on Railway

### 1. Generate the session string (once, locally)

```bash
cp .env.example .env          # fill in TELEGRAM_API_ID and TELEGRAM_API_HASH
npm install
npm run login                 # logs in the persona's account
```

You'll be asked for the phone number, the login code Telegram sends, and your 2FA password (if set). It prints two things:

- your **numeric user id** — not needed for the persona, but handy,
- a long **`TELEGRAM_SESSION`** string.

Copy the session string. Treat it like a password: it is full access to the account.

### 2. Deploy

1. Push this repository to GitHub (keep it **private** — `person.md` is personal data and the session is sensitive).

2. In [Railway](https://railway.app): **New Project → Deploy from GitHub repo** and select the repository. Railway detects Node.js automatically (Nixpacks) and runs `npm install` + `npm start`. No Dockerfile needed.

3. Open the service → **Variables** and add (see [`.env.example`](.env.example)):

   | Variable | Value |
   |---|---|
   | `TELEGRAM_API_ID` | from my.telegram.org (**required**) |
   | `TELEGRAM_API_HASH` | from my.telegram.org (**required**) |
   | `OPENROUTER_API_KEY` | your OpenRouter key (**required**) |
   | `S3_ENDPOINT` | e.g. `hel1.your-objectstorage.com` (omit for plain AWS) |
   | `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | your bucket (**required**) |
   | `S3_PREFIX` | optional, e.g. `socrates` |
   | `DASHBOARD_PASSWORD` | a strong password for the web dashboard (**required** — it now also gates Telegram login and all settings) |
   | `PERSON_TIMEZONE` | e.g. `Asia/Hong_Kong` |
   | `TELEGRAM_SESSION` | **optional** — managed in the dashboard now. If set, only seeds `settings.json` on first boot. |
   | `ALLOWED_USER_IDS` | **optional** — managed in the dashboard now. Comma-separated; only seeds the initial allow-list. |
   | `OPENROUTER_MODEL` | **optional** — managed in the dashboard now. e.g. `deepseek/deepseek-v4-flash`; only seeds the initial model. |
   | `OPENROUTER_MEDIA_MODEL` | **optional** — managed in the dashboard now. e.g. `google/gemini-2.5-flash` (vision + audio). |

   Do **not** set `PORT` — Railway injects it automatically and the app reads it.

   > The four "optional / managed in the dashboard" variables used to be required. They've moved into `settings.json` so you can change them live. You can deploy with **only** the required ones above, then open the dashboard → **Connection** to log the account in and → **Settings** to pick a model and add allowed contacts. Setting them as env vars still works — they simply seed `settings.json` the first time the app boots.

4. **Settings → Networking → Generate Domain** to get a public URL. That URL serves the dashboard at `/` (login with `DASHBOARD_PASSWORD`), plus `GET /health` and `GET /status`.

5. **Authorise the account from the dashboard.** Open the URL → log in with `DASHBOARD_PASSWORD` → **Connection** → enter the persona's phone number → enter the code Telegram sends → enter the 2FA password if the account has one. The session is minted and saved to `settings.json`, and the userbot connects immediately. (You can still do the one-time local `npm run login` instead and paste the string into `TELEGRAM_SESSION` if you prefer.)

6. Recommended Railway settings:
   - **Settings → Deploy → Healthcheck Path**: `/health`
   - **Replicas: exactly 1.** The userbot holds one MTProto connection and in-process timers — a second replica would log in the same account twice and double-send messages.
   - **Restart policy**: On Failure. Pending replies/followups are persisted to S3 and restored on boot, so restarts are safe.
   - Use a plan/settings where the service **never sleeps** — a sleeping service can't send the "7 hours later" reply, manage online status, or run typing indicators. (App sleeping is the killer for this use case; the always-on Hobby/Pro plans are fine.)

7. Deploy. Once a session exists (env var or dashboard login), logs should show:

   ```
   [http] listening on :XXXX
   [telegram] userbot connected as Kin (id 123456789)
   [telegram] listening for incoming messages
   ```

   Before you've logged in, the server still boots and stays up so you can authorise from the dashboard — you'll see instead:

   ```
   [http] listening on :XXXX
   [telegram] no authorised session — open the dashboard → Connection to log in (phone + code)
   ```

   Send a message to the persona's account from an allowed contact and watch the decision log:

   ```
   [bot] <- 11111111: u free to do a website?
   [bot] decision for 11111111: answerNeeded=true reaction=- delay=312s followupDelay=14400s memory=true
   ```

> If the userbot won't connect, the session is missing/expired or was created with different `api_id`/`api_hash`. Re-authorise from the dashboard → **Connection** (or re-run `npm run login`) using the same API credentials you deploy with.

### Updating the persona

`person.md` is read once at boot. To change the persona, edit the file, commit, push — Railway redeploys automatically and pending timers are restored from S3.

## Local development

```bash
cp .env.example .env   # only the required vars are needed (see .env.example)
npm install
npm run dev            # auto-restarts on file changes
```

Then open `http://localhost:3000/`, log in, and authorise the account from **Connection** (or paste a `TELEGRAM_SESSION` from `npm run login` into `.env`). Running locally logs in the **same account** as production — don't run both at once against one session.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `/` | dashboard password | Admin dashboard — Contacts (chat, memory, pending edit/send-now, manual send, prune), Settings (accounts, models, behaviour, pause), Connection (login + status) |
| `/api/*` | bearer token from login | Dashboard JSON API |
| `/health` | none | Liveness probe |
| `/status` | none | Model, pause state, connection status, and per-contact summary (log size, pending due times) |

## A note on responsible use

This drives a real Telegram account and is built to be indistinguishable from a human. Two things to keep in mind:

- **People.** Only point it at people who are in on it or would be okay with it — impersonating someone to deceive others can be harmful and, depending on jurisdiction and context, illegal. The allow-list exists for a reason.
- **Telegram's terms.** Automating a user account is allowed for normal, non-abusive use; spam, mass-messaging, or scraping can get the account limited or banned. Keep volume human and conversational. Using a dedicated number you own (not your personal account) is wise — a ban affects whatever account holds the session.
