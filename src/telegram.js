/**
 * Minimal Telegram Bot API client (long polling, no dependencies).
 *
 * Note on "online status": the Bot API has no concept of last-seen/online for
 * bots — Telegram clients never display a presence for bot accounts, so there
 * is nothing to fake there. What IS visible (and what we manage) is the
 * typing indicator ("... is typing"), realistic response timing, and message
 * pacing. See AGENTS.md → "Telegram realism" for the userbot (MTProto)
 * upgrade path if real last-seen simulation is ever needed.
 */
import { config } from './config.js';

const API = `https://api.telegram.org/bot${config.telegram.token}`;

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

/**
 * Long-polls getUpdates forever and invokes onMessage(msg) for every
 * incoming private text message.
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
        if (msg?.text && msg.chat?.type === 'private') {
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
