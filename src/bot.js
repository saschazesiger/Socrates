/**
 * The conversation engine.
 *
 * Flow per incoming message:
 *   1. Ignore senders not in ALLOWED_USER_IDS.
 *   2. Append message to chat.jsonl (append + trim in one function).
 *   3. Cancel any pending reply/followup — a new message changes the situation,
 *      exactly like a human would re-think what to say.
 *   4. Ask OpenRouter for the structured decision (answer, delays, followup, …).
 *   5. Schedule the answer after answerDelay; on send, schedule the followup.
 *   6. If memoryUpdateNeeded, distill chat.jsonl into memory.txt.
 *
 * Pending timers are persisted to state.json in S3, so a "reply in 7 hours"
 * or a "check in next week" followup survives restarts and redeploys.
 */
import { config } from './config.js';
import { appendChat, getChat, getMemory, setMemory, getState, setState } from './store.js';
import { generateReply, updateMemory } from './llm.js';
import { sendHumanLike, longTimeout } from './humanize.js';

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
  console.log(`[bot] <- ${userId}: ${msg.text}`);

  await appendChat(userId, { from: 'them', text: msg.text, chatId });

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
    `[bot] decision for ${userId}: answerNeeded=${decision.answerNeeded} delay=${decision.answerDelay}s followupDelay=${decision.followupDelay}s memory=${decision.memoryUpdateNeeded}`
  );

  if (decision.answerNeeded && decision.answer) {
    await scheduleReply(userId, chatId, decision, generation);
  } else {
    // No reply — but a followup is still always scheduled (e.g. silent read,
    // then a fresh ping later).
    await scheduleFollowup(userId, chatId, decision.followup, decision.followupDelay, generation);
    if (decision.memoryUpdateNeeded) runMemoryUpdate(userId);
  }
}

async function scheduleReply(userId, chatId, decision, generation) {
  const dueAt = Date.now() + decision.answerDelay * 1000;
  await setState(userId, {
    pendingReply: {
      text: decision.answer,
      dueAt,
      followup: decision.followup,
      followupDelay: decision.followupDelay,
      memoryUpdateNeeded: decision.memoryUpdateNeeded,
      chatId,
    },
  });

  liveState(userId).replyTimer = longTimeout(async () => {
    if (liveState(userId).generation !== generation) return;
    try {
      await fireReply(userId, chatId, decision, generation);
    } catch (err) {
      console.error(`[bot] failed to send reply to ${userId}:`, err.message);
    }
  }, dueAt - Date.now());
}

async function fireReply(userId, chatId, decision, generation) {
  const bursts = await sendHumanLike(chatId, decision.answer);
  for (const burst of bursts) {
    await appendChat(userId, { from: 'me', text: burst, chatId });
  }
  console.log(`[bot] -> ${userId}: ${decision.answer.slice(0, 80)}`);
  await setState(userId, { pendingReply: null });

  await scheduleFollowup(userId, chatId, decision.followup, decision.followupDelay, generation);
  if (decision.memoryUpdateNeeded) runMemoryUpdate(userId);
}

async function scheduleFollowup(userId, chatId, text, delaySeconds, generation) {
  const dueAt = Date.now() + delaySeconds * 1000;
  await setState(userId, { pendingFollowup: { text, dueAt, chatId } });

  liveState(userId).followupTimer = longTimeout(async () => {
    if (liveState(userId).generation !== generation) return;
    try {
      const bursts = await sendHumanLike(chatId, text);
      for (const burst of bursts) {
        await appendChat(userId, { from: 'me', text: burst, chatId });
      }
      console.log(`[bot] -> ${userId} (followup): ${text.slice(0, 80)}`);
      await setState(userId, { pendingFollowup: null });
      // One followup per cycle; after that we wait for them. No infinite nagging.
    } catch (err) {
      console.error(`[bot] failed to send followup to ${userId}:`, err.message);
    }
  }, dueAt - Date.now());
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
        await fireReply(
          userId,
          p.chatId,
          {
            answer: p.text,
            followup: p.followup,
            followupDelay: p.followupDelay,
            memoryUpdateNeeded: p.memoryUpdateNeeded,
          },
          generation
        ).catch((err) => console.error(`[bot] restored reply failed:`, err.message));
      }, delay);
    } else if (state.pendingFollowup) {
      const p = state.pendingFollowup;
      const delay = Math.max(p.dueAt - Date.now(), 5000 + Math.random() * 60000);
      console.log(`[bot] restoring pending followup for ${userId} in ${Math.round(delay / 1000)}s`);
      await scheduleFollowup(userId, p.chatId, p.text, delay / 1000, generation);
    }
  }
}

/** Snapshot for the /status endpoint. */
export async function statusSnapshot() {
  const users = {};
  for (const userId of config.telegram.allowedUserIds) {
    const state = await getState(userId);
    const chat = await getChat(userId);
    users[userId] = {
      messagesInLog: chat.length,
      lastMessageAt: chat.at(-1)?.ts ?? null,
      pendingReplyDueAt: state.pendingReply ? new Date(state.pendingReply.dueAt).toISOString() : null,
      pendingFollowupDueAt: state.pendingFollowup
        ? new Date(state.pendingFollowup.dueAt).toISOString()
        : null,
    };
  }
  return users;
}
