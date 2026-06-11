/**
 * Minimal Telegram Bot API client (long polling, no dependencies).
 *
 * Note on "online status": the Bot API has no concept of last-seen/online for
 * bots — Telegram clients never display a presence for bot accounts, so there
 * is nothing to fake there. What IS visible (and what we manage) is the
 * typing indicator ("... is typing"), reactions, realistic response timing,
 * and message pacing. See AGENTS.md → "Telegram realism" for the userbot
 * (MTProto) upgrade path if real last-seen simulation is ever needed.
 */
import { config } from './config.js';

const API = `https://api.telegram.org/bot${config.telegram.token}`;
const FILE_API = `https://api.telegram.org/file/bot${config.telegram.token}`;

export async function api(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.error_code} ${data.description}`);
  }
  return data.result;
}

export function sendMessage(chatId, text) {
  return api('sendMessage', { chat_id: chatId, text });
}

export function sendTyping(chatId) {
  // A single "typing" chat action shows for ~5 seconds on the client.
  return api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
}

// Telegram only accepts reactions from this fixed emoji set.
export const ALLOWED_REACTIONS = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉',
  '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥',
  '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾',
  '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇',
  '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒',
  '💘', '🙉', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
]);

// Common LLM outputs mapped onto Telegram's allowed set.
const REACTION_ALIASES = { '❤️': '❤', '😂': '🤣', '🙂': '👍', '😊': '🥰', '😆': '😁', '✌️': '👌' };

/** Returns the normalized emoji if Telegram accepts it, else null. */
export function normalizeReaction(emoji) {
  if (!emoji || typeof emoji !== 'string') return null;
  const e = REACTION_ALIASES[emoji.trim()] ?? emoji.trim().replace(/️/g, '');
  return ALLOWED_REACTIONS.has(e) ? e : null;
}

export function setReaction(chatId, messageId, emoji) {
  return api('setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  });
}

/** Downloads a Telegram file by file_id, returns a Buffer. */
export async function downloadFile(fileId) {
  const file = await api('getFile', { file_id: fileId });
  const res = await fetch(`${FILE_API}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Long-polls getUpdates forever and invokes onMessage(msg) for every
 * incoming private message containing text, a photo or a voice note.
 */
export async function startPolling(onMessage) {
  // Drop any webhook so getUpdates works.
  await api('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  let offset = 0;
  console.log('[telegram] long polling started');
  for (;;) {
    try {
      const updates = await api('getUpdates', {
        offset,
        timeout: 50,
        allowed_updates: ['message'],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        const hasContent = msg && (msg.text || msg.photo?.length || msg.voice);
        if (hasContent && msg.chat?.type === 'private') {
          Promise.resolve(onMessage(msg)).catch((err) =>
            console.error('[telegram] onMessage error:', err)
          );
        }
      }
    } catch (err) {
      console.error('[telegram] polling error, retrying in 5s:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
