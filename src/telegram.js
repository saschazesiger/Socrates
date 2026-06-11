/**
 * Telegram transport — MTProto **userbot** (a real user account, not a Bot API
 * bot) driven by gramjs. Using a real account is what makes the persona
 * indistinguishable: it has a genuine online/last-seen presence, real read
 * receipts we control, no "bot" badge, and the full set of user features.
 *
 * Auth: needs api_id/api_hash (from https://my.telegram.org → API development
 * tools) and a StringSession. The session is held in settings.json (S3) and can
 * be minted entirely from the dashboard (phone → code → 2FA), or once locally
 * via `npm run login`. None of that is a bot token.
 *
 * Peers are passed around the app as a serializable descriptor
 * `{ id, accessHash }` (the value the rest of the code calls "chatId"). It is
 * stored in S3 state, so followups can be sent days later — even across
 * restarts — without needing to re-resolve the entity.
 */
import crypto from 'node:crypto';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { computeCheck } from 'telegram/Password.js';
import bigInt from 'big-integer';
import { config } from './config.js';
import { getSettings } from './settings.js';

let client = null;
let onMessageHandler = null; // remembered so restart() can re-register it
let meCache = null; // { id, firstName, lastName, username, phone }
const nameCache = new Map(); // userId -> display name

/** The session string currently in effect (settings override the env seed). */
function currentSession() {
  return getSettings().session || config.telegram.session || '';
}

export function getClient() {
  if (!client) {
    client = new TelegramClient(
      new StringSession(currentSession()),
      config.telegram.apiId,
      config.telegram.apiHash,
      { connectionRetries: 5, autoReconnect: true }
    );
    client.setLogLevel('error'); // gramjs is very chatty at info level
  }
  return client;
}

/** Build an InputPeerUser from the serializable { id, accessHash } descriptor. */
function toInputPeer(peer) {
  if (peer instanceof Api.InputPeerUser) return peer;
  return new Api.InputPeerUser({
    userId: bigInt(String(peer.id)),
    accessHash: bigInt(String(peer.accessHash ?? '0')),
  });
}

/** Descriptor for a sender we can persist and reuse later. */
function peerDescriptor(inputUser) {
  return {
    id: inputUser.userId.toString(),
    accessHash: (inputUser.accessHash ?? bigInt(0)).toString(),
  };
}

// ── Presence (the userbot-only superpower) ──────────────────────────────────

/** Show/hide the account's "online" / "last seen" status to contacts. */
export async function setOnline(online) {
  try {
    await getClient().invoke(new Api.account.UpdateStatus({ offline: !online }));
  } catch (err) {
    console.error('[telegram] setOnline failed:', err.message);
  }
}

/** Mark the conversation read up to maxId — a real, controllable read receipt. */
export async function markRead(peer, maxId) {
  try {
    await getClient().invoke(
      new Api.messages.ReadHistory({ peer: toInputPeer(peer), maxId: maxId ?? 0 })
    );
  } catch (err) {
    console.error('[telegram] markRead failed:', err.message);
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────

export async function sendMessage(peer, text) {
  return getClient().sendMessage(toInputPeer(peer), { message: text });
}

export async function sendTyping(peer) {
  try {
    await getClient().invoke(
      new Api.messages.SetTyping({
        peer: toInputPeer(peer),
        action: new Api.SendMessageTypingAction(),
      })
    );
  } catch {
    /* typing is best-effort */
  }
}

// Standard free-account reactions; user accounts can send these in private chats.
export const ALLOWED_REACTIONS = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉',
  '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥',
  '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾',
  '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇',
  '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒',
  '💘', '🙉', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
]);

const REACTION_ALIASES = { '❤️': '❤', '😂': '🤣', '🙂': '👍', '😊': '🥰', '😆': '😁', '✌️': '👌' };

/** Returns the normalized emoji if Telegram accepts it, else null. */
export function normalizeReaction(emoji) {
  if (!emoji || typeof emoji !== 'string') return null;
  const e = REACTION_ALIASES[emoji.trim()] ?? emoji.trim().replace(/️/g, '');
  return ALLOWED_REACTIONS.has(e) ? e : null;
}

export async function setReaction(peer, messageId, emoji) {
  await getClient().invoke(
    new Api.messages.SendReaction({
      peer: toInputPeer(peer),
      msgId: messageId,
      reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
    })
  );
}

// ── Incoming media ──────────────────────────────────────────────────────────

/** Downloads the media of a raw gramjs message, returns a Buffer. */
export async function downloadMedia(rawMessage) {
  return getClient().downloadMedia(rawMessage, {});
}

function voiceDuration(message) {
  const doc = message.voice;
  const attr = doc?.attributes?.find((a) => a instanceof Api.DocumentAttributeAudio);
  return attr?.duration ?? 0;
}

/**
 * Normalizes a raw gramjs message into the shape the rest of the app uses.
 * In MTProto a media message's caption lives in `message.message`.
 */
async function normalize(message) {
  const inputSender = await message.getInputSender(); // Api.InputPeerUser (id + accessHash)
  const peer = peerDescriptor(inputSender);
  cacheName(message); // remember a display name for the dashboard
  const isPhoto = Boolean(message.photo);
  const isVoice = Boolean(message.voice);
  const hasMedia = isPhoto || isVoice;
  return {
    message_id: message.id,
    from: { id: peer.id },
    peer, // serializable; used everywhere as "chatId"
    text: hasMedia ? '' : message.message || '',
    caption: hasMedia ? message.message || '' : '',
    isPhoto,
    voice: isVoice ? { duration: voiceDuration(message) } : null,
    raw: message,
  };
}

// ── Contact identity (for the dashboard) ─────────────────────────────────────

function nameFromEntity(e) {
  if (!e) return null;
  const full = [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
  return full || (e.username ? `@${e.username}` : null);
}

function cacheName(message) {
  try {
    const sender = message.sender ?? message._sender;
    const name = nameFromEntity(sender);
    if (sender?.id && name) nameCache.set(String(sender.id), name);
  } catch {
    /* best effort */
  }
}

/** Best-effort human name for a contact; cached. Null if it can't be resolved. */
export async function getContactName(userId, peer) {
  const id = String(userId);
  if (nameCache.has(id)) return nameCache.get(id);
  if (!peer) return null;
  try {
    const entity = await getClient().getEntity(toInputPeer(peer));
    const name = nameFromEntity(entity);
    if (name) nameCache.set(id, name);
    return name;
  } catch {
    return null;
  }
}

// ── Connection status ────────────────────────────────────────────────────────

export function getMe() {
  return meCache;
}

/** Register the incoming-message handler up front so restart() always has it. */
export function setMessageHandler(fn) {
  onMessageHandler = fn;
}

/** Live connection/authorisation status for the dashboard. */
export async function connectionStatus() {
  try {
    const c = getClient();
    if (!c.connected) await c.connect();
    const authorized = await c.checkAuthorization();
    if (authorized && !meCache) await cacheMe(c);
    return {
      connected: Boolean(c.connected),
      authorized,
      me: authorized ? meCache : null,
    };
  } catch (err) {
    return { connected: false, authorized: false, me: null, error: err.message };
  }
}

async function cacheMe(c) {
  const u = await c.getMe();
  meCache = {
    id: String(u.id),
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    username: u.username ?? null,
    phone: u.phone ?? null,
  };
  return meCache;
}

// ── Dashboard login flow (phone → code → optional 2FA) ───────────────────────
//
// Each in-progress login owns a SEPARATE throwaway client so it never disturbs
// the running userbot connection. On success the caller persists the returned
// session string to settings.json and calls restart().

const logins = new Map(); // loginId -> { client, phone, phoneCodeHash, at }

function freshLoginClient() {
  const c = new TelegramClient(new StringSession(''), config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 5,
  });
  c.setLogLevel('error');
  return c;
}

/** Step 1: send the login code to `phone`. Returns a loginId to continue with. */
export async function loginStart(phone) {
  const phoneNumber = String(phone || '').trim();
  if (!phoneNumber) throw new Error('phone number required');
  const c = freshLoginClient();
  await c.connect();
  const res = await c.invoke(
    new Api.auth.SendCode({
      phoneNumber,
      apiId: config.telegram.apiId,
      apiHash: config.telegram.apiHash,
      settings: new Api.CodeSettings({}),
    })
  );
  const loginId = crypto.randomBytes(8).toString('hex');
  logins.set(loginId, { client: c, phone: phoneNumber, phoneCodeHash: res.phoneCodeHash, at: Date.now() });
  return { loginId };
}

/** Step 2: submit the SMS/app code. May report that a 2FA password is needed. */
export async function loginCode(loginId, code) {
  const s = logins.get(loginId);
  if (!s) throw new Error('login session expired — start again');
  try {
    await s.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: s.phone,
        phoneCodeHash: s.phoneCodeHash,
        phoneCode: String(code || '').trim(),
      })
    );
  } catch (err) {
    if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') return { status: 'password_needed' };
    throw err;
  }
  return finishLogin(loginId, s);
}

/** Step 3 (only if 2FA): submit the cloud password. */
export async function loginPassword(loginId, password) {
  const s = logins.get(loginId);
  if (!s) throw new Error('login session expired — start again');
  const pwInfo = await s.client.invoke(new Api.account.GetPassword());
  const check = await computeCheck(pwInfo, String(password || ''));
  await s.client.invoke(new Api.auth.CheckPassword({ password: check }));
  return finishLogin(loginId, s);
}

async function finishLogin(loginId, s) {
  const session = s.client.session.save();
  try {
    await s.client.disconnect();
  } catch {
    /* ignore */
  }
  logins.delete(loginId);
  return { status: 'authorized', session };
}

export function cancelLogin(loginId) {
  const s = logins.get(loginId);
  if (s) {
    s.client.disconnect().catch(() => {});
    logins.delete(loginId);
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Connects the userbot, registers the incoming-message handler, and starts
 * "offline" (presence is then driven explicitly when the persona interacts).
 * onMessage receives the normalized message object.
 *
 * If there is no authorised session yet, this does NOT throw — it logs a notice
 * and returns, leaving the HTTP server (and dashboard login flow) running so the
 * account can be authorised from the web UI. After login, restart() connects.
 */
export async function start(onMessage) {
  if (onMessage) onMessageHandler = onMessage;
  const c = getClient();
  await c.connect();
  if (!(await c.checkAuthorization())) {
    meCache = null;
    console.warn(
      '[telegram] no authorised session — open the dashboard → Connection to log in (phone + code)'
    );
    return;
  }
  await cacheMe(c);
  console.log(`[telegram] userbot connected as ${meCache.firstName ?? ''} (id ${meCache.id})`);

  // Don't broadcast online just because we connected.
  await setOnline(false);

  c.addEventHandler(async (event) => {
    try {
      const msg = await normalize(event.message);
      await onMessageHandler(msg);
    } catch (err) {
      console.error('[telegram] onMessage error:', err);
    }
  }, new NewMessage({ incoming: true }));

  console.log('[telegram] listening for incoming messages');
}

/**
 * Tears down the current connection and reconnects with whatever session is now
 * in settings.json. Used after a dashboard login (or session change). Re-uses
 * the message handler captured by the first start().
 */
export async function restart() {
  if (client) {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
    client = null;
  }
  meCache = null;
  await start();
  return connectionStatus();
}

/** Clears the in-memory cached identity (used after logout). */
export async function logout() {
  meCache = null;
  if (client) {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    client = null;
  }
}
