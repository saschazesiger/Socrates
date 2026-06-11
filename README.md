# Socrates — Telegram Persona Bot

A Node.js app that imitates a real person over Telegram. It wraps any [OpenRouter](https://openrouter.ai) model with a persona defined in [`person.md`](person.md) and reproduces real human texting behaviour:

- **Realistic reply timing** — the LLM decides how long "you" would take to answer, based on the persona's daily schedule (asleep at night → reply next morning; at work → an hour; evening banter → seconds).
- **Typing indicator & message bursts** — typing duration scales with message length; long answers arrive as several short messages, like real texting.
- **Reactions & typos** — occasionally reacts with 👍/🤣 instead of replying, and rarely sends a typo followed by the classic `*correction`.
- **Selective silence** — leaves "ok"-type messages on read, like a person would.
- **Always a followup planned** — if the contact goes quiet, the persona naturally re-engages later ("how did the interview go?"). There is *always* exactly one upcoming followup scheduled per contact; it's discarded the moment they reply.
- **Photos & voice notes** — incoming photos are described and voice messages transcribed via a vision/audio-capable model, so the persona reacts to their content.
- **Long-term memory** — chat history keeps the last 200 messages per contact (`chat.jsonl`); important facts are distilled into a per-contact `memory.txt` so nothing is lost.
- **Admin dashboard** — password-protected web UI to inspect conversations, edit memory, cancel/regenerate pending messages, and send manual messages as the persona.

Everything persists to S3-compatible storage, so the app itself is stateless and survives restarts/redeploys — including "reply tomorrow at 7am" timers.

> Full technical documentation (architecture, data layout, LLM contract, how to write a `person.md`) lives in [AGENTS.md](AGENTS.md).

## Prerequisites

1. **Telegram bot** — create one with [@BotFather](https://t.me/BotFather), copy the token. In BotFather, set a real-sounding name and a profile photo; disable `/start`-style command menus (Edit Bot → Edit Commands → leave empty).
2. **Your contacts' Telegram user IDs** — each allowed person can get theirs from [@userinfobot](https://t.me/userinfobot). Everyone else is silently ignored.
3. **OpenRouter account** — API key from [openrouter.ai/keys](https://openrouter.ai/keys). Pick a main model that's good at persona instructions + JSON output, and a media model that supports vision *and* audio (e.g. `google/gemini-2.5-flash`) for photos/voice.
4. **S3-compatible bucket** — AWS S3, Cloudflare R2, Hetzner Object Storage, MinIO… anything with the S3 API.
5. **A `person.md`** — edit the one in this repo. It ships as a complete example persona; the believability of the whole bot depends on this file. See [AGENTS.md → Crafting a person.md](AGENTS.md#crafting-a-personmd).

## Deploy on Railway

1. Push this repository to GitHub (keep it **private** — `person.md` is personal data).

2. In [Railway](https://railway.app): **New Project → Deploy from GitHub repo** and select the repository. Railway detects Node.js automatically (Nixpacks) and runs `npm install` + `npm start`. No Dockerfile needed.

3. Open the service → **Variables** and add (see [`.env.example`](.env.example)):

   | Variable | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | from BotFather |
   | `ALLOWED_USER_IDS` | comma-separated Telegram user IDs |
   | `OPENROUTER_API_KEY` | your OpenRouter key |
   | `OPENROUTER_MODEL` | e.g. `deepseek/deepseek-v4-flash` |
   | `OPENROUTER_MEDIA_MODEL` | e.g. `google/gemini-2.5-flash` (vision + audio) |
   | `S3_ENDPOINT` | e.g. `hel1.your-objectstorage.com` (omit for plain AWS) |
   | `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | your bucket |
   | `S3_PREFIX` | optional, e.g. `socrates` |
   | `DASHBOARD_PASSWORD` | a strong password for the web dashboard |
   | `PERSON_TIMEZONE` | e.g. `Europe/Zurich` |

   Do **not** set `PORT` — Railway injects it automatically and the app reads it.

4. **Settings → Networking → Generate Domain** to get a public URL. That URL serves the dashboard at `/` (login with `DASHBOARD_PASSWORD`), plus `GET /health` and `GET /status`.

5. Recommended Railway settings:
   - **Settings → Deploy → Healthcheck Path**: `/health`
   - **Replicas: exactly 1.** The bot uses Telegram long polling and in-process timers — two replicas would fight over `getUpdates` and double-send messages.
   - **Restart policy**: On Failure. Pending replies/followups are persisted to S3 and restored on boot, so restarts are safe.
   - Use a plan/settings where the service **never sleeps** — a sleeping service can't send the "7 hours later" reply or run typing indicators. (App sleeping is the killer for this use case; the always-on Hobby/Pro plans are fine.)

6. Deploy. Logs should show:

   ```
   [http] listening on :XXXX
   [telegram] long polling started
   ```

   Send a message from an allowed account and watch the decision log:

   ```
   [bot] <- 11111111: hey was machst du
   [bot] decision for 11111111: answerNeeded=true reaction=- delay=312s followupDelay=14400s memory=false
   ```

### Updating the persona

`person.md` is read once at boot. To change the persona, edit the file, commit, push — Railway redeploys automatically and pending timers are restored from S3.

## Local development

```bash
cp .env.example .env   # fill in real values
npm install
npm run dev            # auto-restarts on file changes
```

Dashboard at `http://localhost:3000/`.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `/` | dashboard password | Admin dashboard (chat view, memory editor, pending actions, manual send) |
| `/api/*` | bearer token from login | Dashboard JSON API |
| `/health` | none | Liveness probe |
| `/status` | none | Per-contact summary (log size, pending reply/followup due times) |

## A note on responsible use

This bot is built to be indistinguishable from a human. Only point it at people who are in on it or would be okay with it — impersonating someone to deceive others can be harmful and, depending on jurisdiction and context, illegal. The allow-list exists for a reason.
