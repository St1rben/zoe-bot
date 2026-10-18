/** Обробка команд із Telegram-вебхука: /start, /help, /queue, /status. */

import {
  formatHelp,
  formatQueueCurrent,
  formatQueueInvalid,
  formatQueueSet,
  formatStatus,
  formatUpdate,
  formatWelcome,
} from "./messages";
import { stalePostNote } from "./monitor";
import { scenarioFor, type Scenario } from "./parser";
import {
  ensureChat,
  getChatQueue,
  getChatState,
  getMeta,
  postFromMeta,
  putChatState,
  setChatQueue,
} from "./state";
import { sendMessage, type TelegramChatMemberUpdated, type TelegramUpdate } from "./telegram";

const QUEUE_RE = /^\d+(?:\.\d+)?$/;
const COMMAND_RE = /^\/(\w+)(?:@\S+)?(?:\s+(.*))?$/s;

export async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  if (update.my_chat_member !== undefined) {
    await handleBotMembership(env, update.my_chat_member);
    return;
  }

  const message = update.message;
  const text = message?.text?.trim();
  if (message === undefined || !text) return;

  const match = COMMAND_RE.exec(text);
  if (match === null) return;
  const command = (match[1] ?? "").toLowerCase();
  const argument = (match[2] ?? "").trim();
  const chatId = message.chat.id;

  switch (command) {
    case "start": {
      await ensureChat(env, chatId);
      const queue = (await getChatQueue(env, chatId)) ?? env.QUEUE;
      await sendMessage(env, chatId, formatWelcome(queue));
      // Якщо останній пост уже відомий — одразу показуємо актуальний графік.
      await sendCurrentSchedule(env, chatId, queue);
      break;
    }
    case "help":
      await sendMessage(env, chatId, formatHelp());
      break;
    case "queue":
      await handleQueue(env, chatId, argument);
      break;
    case "status":
      await handleStatus(env, chatId);
      break;
    default:
      break;
  }
}

/**
 * Коли бота додають у чат (my_chat_member → member/administrator), одразу
 * вітаємось і показуємо поточний графік — чат працює без команди /start.
 */
async function handleBotMembership(env: Env, event: TelegramChatMemberUpdated): Promise<void> {
  const previous = event.old_chat_member?.status ?? "left";
  const current = event.new_chat_member?.status ?? "";
  const joined =
    (previous === "left" || previous === "kicked") &&
    (current === "member" || current === "administrator");
  if (!joined) return;

  const chatId = event.chat.id;
  await ensureChat(env, chatId);
  const queue = (await getChatQueue(env, chatId)) ?? env.QUEUE;
  await sendMessage(env, chatId, formatWelcome(queue));
  await sendCurrentSchedule(env, chatId, queue);
}

async function handleQueue(env: Env, chatId: number, argument: string): Promise<void> {
  if (argument === "") {
    const customQueue = await getChatQueue(env, chatId);
    await sendMessage(env, chatId, formatQueueCurrent(customQueue ?? env.QUEUE, customQueue === null));
    return;
  }
  if (!QUEUE_RE.test(argument)) {
    await sendMessage(env, chatId, formatQueueInvalid(argument));
    return;
  }
  await setChatQueue(env, chatId, argument);
  await sendMessage(env, chatId, formatQueueSet(argument));
  // Одразу показуємо графік для нової черги, якщо останній пост відомий.
  await sendCurrentSchedule(env, chatId, argument);
}

/** Надсилає поточний графік черги з meta і фіксує стан чату (дедуплікація). */
async function sendCurrentSchedule(env: Env, chatId: number, queue: string): Promise<void> {
  const post = postFromMeta(await getMeta(env));
  if (post === null) return;
  const scenario = scenarioFor(post, queue);
  if (await sendMessage(env, chatId, formatUpdate(post.title, queue, scenario))) {
    await putChatState(env, chatId, {
      postId: post.id,
      queue,
      scenario: scenario.kind,
      times: scenario.times,
      updatedAt: Date.now(),
    });
  }
}

async function handleStatus(env: Env, chatId: number): Promise<void> {
  const queue = (await getChatQueue(env, chatId)) ?? env.QUEUE;
  const meta = await getMeta(env);
  const chatState = await getChatState(env, chatId);
  const fresh = chatState !== null && chatState.postId === meta.lastPostId && chatState.queue === queue;
  const scenario: Scenario | null = fresh
    ? { kind: chatState.scenario, times: chatState.times }
    : null;
  const staleNote = stalePostNote(meta.lastPostTitle, new Date(), env.DIGEST_TZ || "Europe/Kyiv");

  await sendMessage(
    env,
    chatId,
    formatStatus({
      queue,
      title: meta.lastPostTitle,
      scenario,
      updatedAt: meta.updatedAt,
      staleNote,
      checkedAt: meta.lastIngestAt,
    }),
  );
}
