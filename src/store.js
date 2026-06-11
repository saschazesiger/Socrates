/**
 * Conversation data layer.
 *
 * Per allowed user, three artifacts live in S3 (write-through, in-memory cache):
 *   chats/<userId>/chat.jsonl  — last N messages (config.chatHistoryLimit)
 *   chats/<userId>/memory.txt  — long-term facts distilled from conversations
 *   chats/<userId>/state.json  — pending reply / followup timers (survive restarts)
 */
import { s3Get, s3Put, s3Delete, s3List } from './storage.js';
import { config } from './config.js';

const cache = new Map(); // key -> parsed value

function chatKey(userId) {
  return `chats/${userId}/chat.jsonl`;
}
function memoryKey(userId) {
  return `chats/${userId}/memory.txt`;
}
function stateKey(userId) {
  return `chats/${userId}/state.json`;
}

// ── chat.jsonl ─────────────────────────────────────────────────────────────

export async function getChat(userId) {
  const key = chatKey(userId);
  if (cache.has(key)) return cache.get(key);
  const raw = await s3Get(key);
  const entries = raw
    ? raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];
  cache.set(key, entries);
  return entries;
}

/**
 * The single general chat-log function: appends a message AND trims old
 * messages past the history limit in the same operation, then persists.
 *
 * entry: { ts: ISO string, from: 'them' | 'me', text: string }
 */
export async function appendChat(userId, entry) {
  const entries = await getChat(userId);
  entries.push({ ts: new Date().toISOString(), ...entry });
  while (entries.length > config.chatHistoryLimit) entries.shift();
  cache.set(chatKey(userId), entries);
  await s3Put(chatKey(userId), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return entries;
}

// ── memory.txt ─────────────────────────────────────────────────────────────

export async function getMemory(userId) {
  const key = memoryKey(userId);
  if (cache.has(key)) return cache.get(key);
  const raw = (await s3Get(key)) ?? '';
  cache.set(key, raw);
  return raw;
}

export async function setMemory(userId, text) {
  cache.set(memoryKey(userId), text);
  await s3Put(memoryKey(userId), text);
}

// ── state.json (pending timers) ────────────────────────────────────────────

const EMPTY_STATE = { pendingReply: null, pendingFollowup: null };

export async function getState(userId) {
  const key = stateKey(userId);
  if (cache.has(key)) return cache.get(key);
  const raw = await s3Get(key);
  let state = { ...EMPTY_STATE };
  if (raw) {
    try {
      state = { ...EMPTY_STATE, ...JSON.parse(raw) };
    } catch {
      /* corrupt state — start fresh */
    }
  }
  cache.set(key, state);
  return state;
}

export async function setState(userId, patch) {
  const state = { ...(await getState(userId)), ...patch };
  cache.set(stateKey(userId), state);
  await s3Put(stateKey(userId), JSON.stringify(state, null, 2));
  return state;
}

// ── Contact discovery & pruning ──────────────────────────────────────────────

/**
 * Every contact that has any data on disk, discovered by listing S3. Needed
 * because with "allow all" the persona talks to people not on any fixed list.
 */
export async function listContactIds() {
  const keys = await s3List('chats/');
  const ids = new Set();
  for (const key of keys) {
    const m = key.match(/^chats\/([^/]+)\//);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

/**
 * Wipes a contact's data so the conversation starts from scratch. Each artifact
 * can be removed independently; by default all three go.
 */
export async function resetContact(userId, { chat = true, memory = true, state = true } = {}) {
  if (chat) {
    cache.delete(chatKey(userId));
    await s3Delete(chatKey(userId));
  }
  if (memory) {
    cache.delete(memoryKey(userId));
    await s3Delete(memoryKey(userId));
  }
  if (state) {
    cache.delete(stateKey(userId));
    await s3Delete(stateKey(userId));
  }
}
