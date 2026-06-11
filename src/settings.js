/**
 * Runtime settings, stored in S3 as `settings.json` (write-through, in-memory
 * cache) and editable live from the dashboard. This is the source of truth for
 * everything an operator needs to change WITHOUT a redeploy:
 *
 *   - session        the Telegram StringSession (minted via the dashboard login
 *                    flow, or `npm run login`). Lives here so a fresh deploy can
 *                    be authorised entirely from the web UI, with no env var.
 *   - allowedUserIds / allowAll   who the persona talks to.
 *   - model / mediaModel          which OpenRouter models drive replies & media.
 *   - behavior        humanisation knobs (typing speed, typo rate, delays, …)
 *                     and a global `paused` kill-switch.
 *
 * On first boot (no settings.json yet) the file is SEEDED from the env vars so
 * existing deployments keep working; after that, the env values are ignored and
 * the dashboard owns these settings.
 */
import { s3Get, s3Put } from './storage.js';
import { config } from './config.js';

const KEY = 'settings.json';

let cache = null;

export const DEFAULT_BEHAVIOR = {
  // Global kill-switch: when true the persona never auto-sends a reply or
  // followup (incoming messages are still read/logged). Manual sends still work.
  paused: false,
  // Likelihood (0–1) a sent message includes a realistic typo + "*correction".
  typoProbability: 0.07,
  // Visible typing speed range (characters per second on a phone).
  typingCharsPerSecMin: 4,
  typingCharsPerSecMax: 7,
  // Cap on how long the "typing…" indicator runs for one message (seconds).
  typingMaxSeconds: 45,
  // Chance (0–1) that typing a longer message pauses partway — the typing
  // indicator lapses, like a human stopping to think, then resumes.
  typingPauseChance: 0.25,
  // Pause between burst messages of one reply (milliseconds).
  burstGapMinMs: 800,
  burstGapMaxMs: 2500,
  // How long the account lingers "online" after acting before going offline.
  onlineLingerMinMs: 5000,
  onlineLingerMaxMs: 30000,
  // ± fraction of random jitter applied to every LLM-chosen delay so they never
  // form a statistical fingerprint.
  answerDelayJitter: 0.12,
  // Clamp for the LLM-chosen answer delay (seconds).
  minAnswerDelaySeconds: 2,
  maxAnswerDelaySeconds: 14 * 3600,
  // Sampling temperature for the reply/followup LLM calls.
  replyTemperature: 0.9,
};

function defaults() {
  return {
    session: config.telegram.session || '',
    allowedUserIds: [...config.telegram.allowedUserIds],
    allowAll: false,
    model: config.openrouter.model || '',
    mediaModel: config.openrouter.mediaModel || '',
    behavior: { ...DEFAULT_BEHAVIOR },
  };
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** Recursive merge: nested plain objects merge; arrays/scalars are replaced. */
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Loads settings.json from S3, seeding it from env defaults on first boot. */
export async function loadSettings() {
  const raw = await s3Get(KEY);
  if (raw) {
    try {
      // Merge over defaults so settings written by an older version still gain
      // any newly-added fields with sane values.
      cache = deepMerge(defaults(), JSON.parse(raw));
    } catch {
      cache = defaults();
    }
  } else {
    cache = defaults();
    await s3Put(KEY, JSON.stringify(cache, null, 2));
    console.log('[settings] seeded settings.json from environment');
  }
  return cache;
}

/** Synchronous accessor. Falls back to env defaults if loadSettings hasn't run. */
export function getSettings() {
  if (!cache) cache = defaults();
  return cache;
}

/** Deep-merges `patch` into the live settings and persists to S3. */
export async function updateSettings(patch) {
  cache = deepMerge(getSettings(), patch);
  await s3Put(KEY, JSON.stringify(cache, null, 2));
  return cache;
}

// ── Convenience helpers ─────────────────────────────────────────────────────

export function isAllowed(userId) {
  const s = getSettings();
  if (s.allowAll) return true;
  return s.allowedUserIds.map(String).includes(String(userId));
}

export function configuredUserIds() {
  return getSettings().allowedUserIds.map(String);
}

export function behavior() {
  return getSettings().behavior;
}

/** Settings safe to expose over the API (the session string is redacted). */
export function redactedSettings() {
  const s = getSettings();
  return {
    allowedUserIds: s.allowedUserIds,
    allowAll: s.allowAll,
    model: s.model,
    mediaModel: s.mediaModel,
    behavior: s.behavior,
    hasSession: Boolean(s.session),
  };
}
