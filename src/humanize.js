/**
 * Everything that makes the bot's Telegram behaviour feel like a human:
 * typing indicators proportional to message length, multi-message bursts,
 * natural pauses, and long-running timers that survive setTimeout limits.
 */
import { sendMessage, sendTyping } from './telegram.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rand(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * How long a human would visibly type a message of this length.
 * Roughly 4–7 chars/sec on a phone, clamped so even essays don't show
 * 5 minutes of typing.
 */
export function typingDuration(text) {
  const cps = rand(4, 7);
  const seconds = text.length / cps + rand(0.5, 2);
  return Math.min(45, Math.max(1.5, seconds)) * 1000;
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
 * Sends `text` like a human: split into bursts on blank lines, each burst
 * preceded by a realistic typing period, with short pauses between bursts.
 * Returns the array of burst strings actually sent.
 */
export async function sendHumanLike(chatId, text) {
  const bursts = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  for (let i = 0; i < bursts.length; i++) {
    if (i > 0) await sleep(rand(800, 2500)); // breather between bursts
    await typeFor(chatId, typingDuration(bursts[i]));
    await sendMessage(chatId, bursts[i]);
  }
  return bursts;
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
