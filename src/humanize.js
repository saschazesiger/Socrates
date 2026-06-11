/**
 * Everything that makes the bot's Telegram behaviour feel like a human:
 * typing indicators proportional to message length, multi-message bursts,
 * natural pauses, occasional typo + "*correction" follow-ups, and
 * long-running timers that survive setTimeout limits.
 */
import { sendMessage, sendTyping } from './telegram.js';
import { behavior } from './settings.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rand(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * How long a human would visibly type a message of this length.
 * Speed range and cap come from settings.behavior so they can be tuned live.
 */
export function typingDuration(text) {
  const b = behavior();
  const cps = rand(b.typingCharsPerSecMin, b.typingCharsPerSecMax);
  const seconds = text.length / cps + rand(0.5, 2);
  return Math.min(b.typingMaxSeconds, Math.max(1.5, seconds)) * 1000;
}

/**
 * Keeps the "typing…" indicator alive for `ms` milliseconds.
 * Telegram shows a chat action for ~5s, so we re-send every 4s.
 */
async function typeFor(chatId, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await sendTyping(chatId);
    await sleep(Math.min(4000, until - Date.now()));
  }
}

/**
 * Types a single message, occasionally pausing partway through for a longer one
 * (the typing indicator lapses and resumes) — the way a person stops to think
 * mid-sentence. Frequency comes from settings.behavior.typingPauseChance.
 */
async function typeMessage(chatId, text) {
  const total = typingDuration(text);
  if (text.length > 35 && Math.random() < (behavior().typingPauseChance ?? 0)) {
    const split = 0.4 + Math.random() * 0.3; // type 40–70%, pause, finish
    await typeFor(chatId, total * split);
    await sleep(rand(700, 1800)); // think — Telegram drops the "typing…" here
    await typeFor(chatId, total * (1 - split));
  } else {
    await typeFor(chatId, total);
  }
}

/**
 * Occasionally introduces a realistic fat-finger typo (adjacent letter swap
 * in one word) and returns the "*word" correction to send right after —
 * the classic human pattern. Returns { text, correction|null }.
 * Probability comes from settings.behavior.typoProbability.
 */
export function maybeTypo(text) {
  if (text.length < 15 || Math.random() > behavior().typoProbability) {
    return { text, correction: null };
  }
  const words = text.split(' ');
  // Pick a purely alphabetic word long enough that a swap is plausible.
  const candidates = words
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.length >= 5 && /^[\p{L}]+$/u.test(w));
  if (!candidates.length) return { text, correction: null };

  const { w, i } = candidates[Math.floor(Math.random() * candidates.length)];
  const pos = 1 + Math.floor(Math.random() * (w.length - 2));
  const typoed = w.slice(0, pos) + w[pos + 1] + w[pos] + w.slice(pos + 2);
  if (typoed === w) return { text, correction: null };

  words[i] = typoed;
  return { text: words.join(' '), correction: `*${w}` };
}

/**
 * Sends `text` like a human: split into bursts on blank lines, each burst
 * preceded by a realistic typing period, with short pauses between bursts.
 * Occasionally a burst goes out with a typo, followed by a quick "*fix".
 * Returns the array of strings actually sent (in order).
 */
export async function sendHumanLike(chatId, text) {
  const bursts = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const b = behavior();
  const sent = [];
  let typoUsed = false; // at most one typo per send — humans aren't that sloppy
  for (let i = 0; i < bursts.length; i++) {
    if (i > 0) await sleep(rand(b.burstGapMinMs, b.burstGapMaxMs)); // breather between bursts

    let burst = bursts[i];
    let correction = null;
    if (!typoUsed) {
      ({ text: burst, correction } = maybeTypo(burst));
      if (correction) typoUsed = true;
    }

    await typeMessage(chatId, burst);
    await sendMessage(chatId, burst);
    sent.push(burst);

    if (correction) {
      await sleep(rand(1500, 5000)); // notice the typo, fix it
      await typeFor(chatId, typingDuration(correction));
      await sendMessage(chatId, correction);
      sent.push(correction);
    }
  }
  return sent;
}

/**
 * setTimeout safe for arbitrarily long delays (chains under the ~24.8 day
 * signed-int32 limit). Returns a handle with cancel().
 */
export function longTimeout(fn, ms) {
  const MAX = 2 ** 31 - 1;
  let timer;
  let cancelled = false;
  const schedule = (remaining) => {
    timer = setTimeout(() => {
      if (cancelled) return;
      if (remaining > MAX) schedule(remaining - MAX);
      else fn();
    }, Math.min(remaining, MAX));
  };
  schedule(Math.max(0, ms));
  return {
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}
