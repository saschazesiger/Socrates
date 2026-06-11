/**
 * Telegram transport — MTProto **userbot** (a real user account, not a Bot API
 * bot) driven by gramjs. Using a real account is what makes the persona
 * indistinguishable: it has a genuine online/last-seen presence, real read
 * receipts we control, no "bot" badge, and the full set of user features.
 *
 * Auth: needs api_id/api_hash (from https://my.telegram.org → API development
 * tools) and a StringSession produced once by `npm run login`. None of that is
 * a bot token.
 *
 * Peers are passed around the app as a serializable descriptor
 * `{ id, accessHash }` (the value the rest of the code calls "chatId"). It is
 * stored in S3 state, so followups can be sent days later — even across
 * restarts — without needing to re-resolve the entity.
 */
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import bigInt from 'big-integer';
import { config } from './config.js';

let client = null;

export function getClient() {
  if (!client) {
    client = new TelegramClient(
      new StringSession(config.telegram.session),
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

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Connects the userbot, registers the incoming-message handler, and starts
 * "offline" (presence is then driven explicitly when the persona interacts).
 * onMessage receives the normalized message object.
 */
export async function start(onMessage) {
  const c = getClient();
  await c.connect();
  if (!(await c.checkAuthorization())) {
    throw new Error(
      'Telegram session is not authorized. Run `npm run login` to create TELEGRAM_SESSION.'
    );
  }
  const me = await c.getMe();
  console.log(`[telegram] userbot connected as ${me.firstName ?? ''} (id ${me.id})`);

  // Don't broadcast online just because we connected.
  await setOnline(false);

  c.addEventHandler(async (event) => {
    try {
      const msg = await normalize(event.message);
      await onMessage(msg);
    } catch (err) {
      console.error('[telegram] onMessage error:', err);
    }
  }, new NewMessage({ incoming: true }));

  console.log('[telegram] listening for incoming messages');
}
