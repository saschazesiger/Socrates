/**
 * The conversation engine.
 *
 * Flow per incoming message:
 *   1. Ignore senders not in ALLOWED_USER_IDS.
 *   2. Resolve media (photo description / voice transcript) to text.
 *   3. Append to chat.jsonl (append + trim in one function).
 *   4. Cancel any pending reply/followup — a new message changes the situation,
 *      exactly like a human would re-think what to say.
 *   5. Ask OpenRouter for the structured decision (answer, reaction, delays, followup, …).
 *   6. Schedule the answer (and/or emoji reaction) after answerDelay; on send,
 *      schedule the followup.
 *   7. If memoryUpdateNeeded, distill chat.jsonl into memory.txt.
 *
 * Followup invariant: every contact with chat history ALWAYS has a pending
 * followup. After a followup fires, the next one is generated immediately
 * (scheduled, not sent). A guard tick runs hourly and backfills a followup
 * for any contact that somehow has none — so the persona keeps initiating
 * contact naturally, never via a visible schedule.
 *
 * Pending timers are persisted to state.json in S3, so a "reply in 7 hours"
 * or a "check in next week" followup survives restarts and redeploys.
 */
import { config } from './config.js';
import { appendChat, getChat, getMemory, setMemory, getState, setState } from './store.js';
import { generateReply, generateFollowup, updateMemory } from './llm.js';
import { sendHumanLike, longTimeout } from './humanize.js';
import { setReaction } from './telegram.js';
import { messageToText } from './media.js';

// userId -> { replyTimer, followupTimer, generation }
const live = new Map();

function liveState(userId) {
  if (!live.has(userId)) live.set(userId, { replyTimer: null, followupTimer: null, generation: 0 });
  return live.get(userId);
}

function cancelTimers(userId) {
  const ls = liveState(userId);
  ls.replyTimer?.cancel();
  ls.followupTimer?.cancel();
  ls.replyTimer = null;
  ls.followupTimer = null;
  ls.generation += 1; // invalidates any in-flight LLM call for this user
  return ls;
}

export async function handleIncoming(msg) {
  const userId = String(msg.from.id);
  if (!config.telegram.allowedUserIds.includes(userId)) {
    console.log(`[bot] ignoring message from non-allowed user ${userId}`);
    return;
  }
  const chatId = msg.chat.id;

  const text = await messageToText(msg);
  console.log(`[bot] <- ${userId}: ${text.slice(0, 120)}`);

  await appendChat(userId, { from: 'them', text, chatId });

  // A new message invalidates whatever we were about to send.
  const ls = cancelTimers(userId);
  const generation = ls.generation;
  await setState(userId, { pendingReply: null, pendingFollowup: null, chatId });

  let decision;
  try {
    decision = await generateReply({
      userId,
      memory: await getMemory(userId),
      chat: await getChat(userId),
    });
  } catch (err) {
    console.error(`[bot] LLM error for ${userId}:`, err.message);
    return;
  }

  // If another message arrived while the LLM was thinking, drop this decision —
  // the newer pipeline run will produce one that includes the newer message.
  if (liveState(userId).generation !== generation) return;

  console.log(
    `[bot] decision for ${userId}: answerNeeded=${decision.answerNeeded} reaction=${decision.reaction ?? '-'} delay=${decision.answerDelay}s followupDelay=${decision.followupDelay}s memory=${decision.memoryUpdateNeeded}`
  );

  if ((decision.answerNeeded && decision.answer) || decision.reaction) {
    // Reaction-only decisions ride the same pending-reply pipeline with empty text.
    await scheduleReply(userId, chatId, {
      text: decision.answerNeeded ? decision.answer : '',
      reaction: decision.reaction,
      messageId: msg.message_id,
      dueAt: Date.now() + decision.answerDelay * 1000,
      followup: decision.followup,
      followupDelay: decision.followupDelay,
      memoryUpdateNeeded: decision.memoryUpdateNeeded,
      chatId,
    }, generation);
  } else {
    // Silent read — but the followup invariant still holds.
    await scheduleFollowup(userId, chatId, decision.followup, decision.followupDelay * 1000, generation);
    if (decision.memoryUpdateNeeded) runMemoryUpdate(userId);
  }
}

async function scheduleReply(userId, chatId, pending, generation) {
  await setState(userId, { pendingReply: pending });
  liveState(userId).replyTimer = longTimeout(async () => {
    if (liveState(userId).generation !== generation) return;
    try {
      await fireReply(userId, chatId, pending, generation);
    } catch (err) {
      console.error(`[bot] failed to send reply to ${userId}:`, err.message);
    }
  }, pending.dueAt - Date.now());
}

async function fireReply(userId, chatId, pending, generation) {
  if (pending.reaction && pending.messageId) {
    try {
      await setReaction(chatId, pending.messageId, pending.reaction);
      await appendChat(userId, {
        from: 'me',
        text: `[reacted ${pending.reaction} to their message]`,
        type: 'reaction',
        chatId,
      });
      console.log(`[bot] -> ${userId}: reacted ${pending.reaction}`);
    } catch (err) {
      console.error(`[bot] reaction failed for ${userId}:`, err.message);
    }
  }

  if (pending.text) {
    // Humans react first, then start typing.
    if (pending.reaction) await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
    const sent = await sendHumanLike(chatId, pending.text);
    for (const burst of sent) {
      await appendChat(userId, { from: 'me', text: burst, chatId });
    }
    console.log(`[bot] -> ${userId}: ${pending.text.slice(0, 80)}`);
  }

  await setState(userId, { pendingReply: null });
  await scheduleFollowup(userId, chatId, pending.followup, pending.followupDelay * 1000, generation);
  if (pending.memoryUpdateNeeded) runMemoryUpdate(userId);
}

async function scheduleFollowup(userId, chatId, text, delayMs, generation) {
  const dueAt = Date.now() + delayMs;
  await setState(userId, { pendingFollowup: { text, dueAt, chatId } });

  liveState(userId).followupTimer = longTimeout(async () => {
    if (liveState(userId).generation !== generation) return;
    try {
      const sent = await sendHumanLike(chatId, text);
      for (const burst of sent) {
        await appendChat(userId, { from: 'me', text: burst, chatId });
      }
      console.log(`[bot] -> ${userId} (followup): ${text.slice(0, 80)}`);
      await setState(userId, { pendingFollowup: null });
      // Followup invariant: immediately plan the NEXT one (scheduled, not sent).
      // The LLM sees the growing run of unanswered messages and naturally
      // spaces them out further / changes topic — no clinginess.
      await chainNextFollowup(userId, chatId, generation);
    } catch (err) {
      console.error(`[bot] failed to send followup to ${userId}:`, err.message);
    }
  }, dueAt - Date.now());
}

async function chainNextFollowup(userId, chatId, generation) {
  try {
    const next = await generateFollowup({
      userId,
      memory: await getMemory(userId),
      chat: await getChat(userId),
    });
    if (liveState(userId).generation !== generation) return; // they replied meanwhile
    console.log(`[bot] next followup for ${userId} in ${Math.round(next.followupDelay / 3600)}h`);
    await scheduleFollowup(userId, chatId, next.followup, next.followupDelay * 1000, generation);
  } catch (err) {
    console.error(`[bot] followup generation failed for ${userId}:`, err.message);
    // The hourly guard will retry.
  }
}

/**
 * Hourly guard: every contact with chat history must always have something
 * pending. If neither a reply nor a followup is scheduled (e.g. after an
 * error, or legacy state), generate a followup now — scheduled, never sent
 * directly, so nothing ever feels like a cron job.
 */
export async function followupGuardTick() {
  for (const userId of config.telegram.allowedUserIds) {
    try {
      const ls = liveState(userId);
      if (ls.replyTimer || ls.followupTimer) continue;
      const state = await getState(userId);
      if (state.pendingReply || state.pendingFollowup) continue;
      const chat = await getChat(userId);
      if (!chat.length) continue; // never cold-open a contact we've never talked to
      const chatId = state.chatId ?? chat.at(-1)?.chatId;
      if (!chatId) continue;
      console.log(`[bot] followup guard: planning followup for ${userId}`);
      await chainNextFollowup(userId, chatId, ls.generation);
    } catch (err) {
      console.error(`[bot] followup guard failed for ${userId}:`, err.message);
    }
  }
}

function runMemoryUpdate(userId) {
  // Fire and forget — memory distillation must never block the chat flow.
  (async () => {
    try {
      const newMemory = await updateMemory({
        memory: await getMemory(userId),
        chat: await getChat(userId),
      });
      if (newMemory) {
        await setMemory(userId, newMemory);
        console.log(`[bot] memory updated for ${userId} (${newMemory.length} chars)`);
      }
    } catch (err) {
      console.error(`[bot] memory update failed for ${userId}:`, err.message);
    }
  })();
}

/**
 * On boot: re-arm timers persisted in state.json. A reply that became due
 * while the app was down fires after a small random "just picked up my
 * phone" delay instead of instantly.
 */
export async function restorePendingTimers() {
  for (const userId of config.telegram.allowedUserIds) {
    const state = await getState(userId);
    const ls = liveState(userId);
    const generation = ls.generation;

    if (state.pendingReply) {
      const p = state.pendingReply;
      const delay = Math.max(p.dueAt - Date.now(), 5000 + Math.random() * 60000);
      console.log(`[bot] restoring pending reply for ${userId} in ${Math.round(delay / 1000)}s`);
      ls.replyTimer = longTimeout(async () => {
        if (liveState(userId).generation !== generation) return;
        await fireReply(userId, p.chatId, p, generation).catch((err) =>
          console.error(`[bot] restored reply failed:`, err.message)
        );
      }, delay);
    } else if (state.pendingFollowup) {
      const p = state.pendingFollowup;
      const delay = Math.max(p.dueAt - Date.now(), 5000 + Math.random() * 60000);
      console.log(`[bot] restoring pending followup for ${userId} in ${Math.round(delay / 1000)}s`);
      await scheduleFollowup(userId, p.chatId, p.text, delay, generation);
    }
  }
}

// ── Dashboard operations ───────────────────────────────────────────────────

export async function statusSnapshot() {
  const users = {};
  for (const userId of config.telegram.allowedUserIds) {
    const state = await getState(userId);
    const chat = await getChat(userId);
    users[userId] = {
      messagesInLog: chat.length,
      lastMessageAt: chat.at(-1)?.ts ?? null,
      lastMessageFrom: chat.at(-1)?.from ?? null,
      pendingReply: state.pendingReply
        ? {
            text: state.pendingReply.text,
            reaction: state.pendingReply.reaction ?? null,
            dueAt: new Date(state.pendingReply.dueAt).toISOString(),
          }
        : null,
      pendingFollowup: state.pendingFollowup
        ? {
            text: state.pendingFollowup.text,
            dueAt: new Date(state.pendingFollowup.dueAt).toISOString(),
          }
        : null,
    };
  }
  return users;
}

export async function cancelPending(userId, kind) {
  const ls = liveState(userId);
  if (kind === 'reply') {
    ls.replyTimer?.cancel();
    ls.replyTimer = null;
    await setState(userId, { pendingReply: null });
  } else if (kind === 'followup') {
    ls.followupTimer?.cancel();
    ls.followupTimer = null;
    await setState(userId, { pendingFollowup: null });
  }
}

/** Sends a manual message as the persona (human-like) and logs it. */
export async function sendManual(userId, text) {
  const state = await getState(userId);
  const chat = await getChat(userId);
  const chatId = state.chatId ?? chat.at(-1)?.chatId;
  if (!chatId) throw new Error('No known chat for this contact yet');
  const sent = await sendHumanLike(chatId, text);
  for (const burst of sent) {
    await appendChat(userId, { from: 'me', text: burst, chatId });
  }
  return sent;
}

/** Discards the pending followup (if any) and plans a fresh one. */
export async function regenerateFollowup(userId) {
  const state = await getState(userId);
  const chat = await getChat(userId);
  const chatId = state.chatId ?? chat.at(-1)?.chatId;
  if (!chatId) throw new Error('No known chat for this contact yet');
  const ls = liveState(userId);
  ls.followupTimer?.cancel();
  ls.followupTimer = null;
  await setState(userId, { pendingFollowup: null });
  await chainNextFollowup(userId, chatId, ls.generation);
  return (await getState(userId)).pendingFollowup;
}

/** Forces a memory distillation right now; returns the new memory text. */
export async function forceMemoryUpdate(userId) {
  const newMemory = await updateMemory({
    memory: await getMemory(userId),
    chat: await getChat(userId),
  });
  await setMemory(userId, newMemory);
  return newMemory;
}
