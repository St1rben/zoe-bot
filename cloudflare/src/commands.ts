/** Обробка команд із Telegram-вебхука: /start, /help, /queue, /status + кнопки вибору черг. */

import {
  formatHelp,
  formatMultiUpdate,
  formatQueueInvalid,
  formatQueueForbidden,
  formatQueueIsDefault,
  formatQueueLimit,
  formatQueuesAdded,
  formatQueuesAlreadyTracked,
  formatQueuesMessage,
  formatQueuesNotTracked,
  formatQueuesRemoved,
  formatQueuesResetToDefault,
  formatQueuesSet,
  formatStatus,
  formatWelcome,
  queuePickerKeyboard,
  type QueueScenarioEntry,
} from "./messages";
import { scenarioMapFromEntries, stalePostNote } from "./monitor";
import {
  MAX_QUEUES_PER_CHAT,
  scenarioFor,
  SEED_QUEUES,
  sortQueues,
} from "./parser";
import {
  ensureChat,
  getChatQueues,
  getChatState,
  getMeta,
  postFromMeta,
  putChatState,
  queuesOr,
  setChatQueues,
} from "./state";
import {
  answerCallbackQuery,
  editMessageText,
  sendMessage,
  type TelegramCallbackQuery,
  type TelegramChatMemberUpdated,
  type TelegramUpdate,
} from "./telegram";

const QUEUE_RE = /^\d+(?:\.\d+)?$/;
const COMMAND_RE = /^\/(\w+)(?:@\S+)?(?:\s+(.*))?$/s;

const ADD_VERBS = new Set(["add", "+"]);
const REMOVE_VERBS = new Set(["remove", "-", "rm"]);

/**
 * Хто може змінювати черги: ADMIN_IDS (список Telegram user ID через кому).
 * Порожньо/не задано — змінювати може будь-хто. Перегляд (/queue, /status) — відкритий.
 */
function isQueueAdmin(env: Env, userId: number | undefined): boolean {
  const raw: string = env.ADMIN_IDS ?? "";
  const ids = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id !== 0);
  if (ids.length === 0) return true;
  return userId !== undefined && ids.includes(userId);
}

/** Автор изменения: пользователь команды или нажавший кнопку. */
function actorId(update: TelegramUpdate): number | undefined {
  if (update.callback_query !== undefined) return update.callback_query.from?.id;
  return update.message?.from?.id;
}

/** Якщо набір порожній або зійшовся до єдиної дефолтної черги — зберігаємо null (режим дефолту). */
function normalizeQueues(
  queues: readonly string[] | null,
  defaultQueue: string,
): string[] | null {
  if (queues === null) return null;
  return queues.length === 1 && queues[0] === defaultQueue ? null : [...queues];
}

export async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  if (update.callback_query !== undefined) {
    await handleQueueToggleCallback(env, update.callback_query);
    return;
  }

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
      const queues = queuesOr(env.QUEUE, await getChatQueues(env, chatId));
      await sendMessage(env, chatId, formatWelcome(queues));
      // Якщо останній пост уже відомий — одразу показуємо актуальний графік.
      await sendCurrentSchedule(env, chatId, queues);
      break;
    }
    case "help":
      await sendMessage(env, chatId, formatHelp());
      break;
    case "queue":
      await handleQueue(env, chatId, argument, actorId(update));
      break;
    case "status":
      await handleStatus(env, chatId);
      break;
    default:
      break;
  }
}

/**
 * Коли бота додають у чат (my_chat_member → member/administrator),
 * тихо реєструємо чат без жодних повідомлень.
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

  // Тихо фіксуємо поточний стан черг без повідомлень у чат
  const meta = await getMeta(env);
  const post = postFromMeta(meta);
  if (post !== null) {
    const queues = queuesOr(env.QUEUE, await getChatQueues(env, chatId));
    const entries = queues.map((queue) => [queue, scenarioFor(post, queue)] as const);
    await putChatState(env, chatId, {
      posts: { [post.id]: { queues: scenarioMapFromEntries(entries) } },
      updatedAt: Date.now(),
    });
  }
}

async function handleQueue(
  env: Env,
  chatId: number,
  argument: string,
  userId: number | undefined,
): Promise<void> {
  if (argument === "") {
    // перегляд — відкритий для всіх
    await showQueuePicker(env, chatId);
    return;
  }

  // зміна набору — лише адміністратор
  if (!isQueueAdmin(env, userId)) {
    await sendMessage(env, chatId, formatQueueForbidden());
    return;
  }

  const tokens = argument.split(/\s+/);
  const verb = (tokens[0] ?? "").toLowerCase();

  if (ADD_VERBS.has(verb)) {
    await handleQueuesAdd(env, chatId, tokens.slice(1));
    return;
  }
  if (REMOVE_VERBS.has(verb)) {
    await handleQueuesRemove(env, chatId, tokens.slice(1));
    return;
  }

  // Легаси-форма: /queue 5.1 (або кілька) — замінити весь набір
  const invalid = tokens.filter((token) => !QUEUE_RE.test(token));
  if (invalid.length > 0) {
    await sendMessage(env, chatId, formatQueueInvalid(invalid.join(" ")));
    return;
  }
  const next = sortQueues(tokens);
  await setChatQueues(env, chatId, normalizeQueues(next, env.QUEUE));
  await sendMessage(env, chatId, formatQueuesSet(next));
  await sendCurrentSchedule(env, chatId, next);
}

async function handleQueuesAdd(env: Env, chatId: number, tokens: string[]): Promise<void> {
  if (tokens.length === 0) {
    await showQueuePicker(env, chatId);
    return;
  }
  const invalid = tokens.filter((token) => !QUEUE_RE.test(token));
  if (invalid.length > 0) {
    await sendMessage(env, chatId, formatQueueInvalid(invalid.join(" ")));
    return;
  }

  await ensureChat(env, chatId);
  const current = queuesOr(env.QUEUE, await getChatQueues(env, chatId));
  const fresh = sortQueues(tokens).filter((queue) => !current.includes(queue));
  if (fresh.length === 0) {
    await sendMessage(env, chatId, formatQueuesAlreadyTracked(sortQueues(tokens)));
    return;
  }
  if (current.length + fresh.length > MAX_QUEUES_PER_CHAT) {
    await sendMessage(env, chatId, formatQueueLimit(MAX_QUEUES_PER_CHAT));
    return;
  }

  const next = [...current, ...fresh];
  await setChatQueues(env, chatId, normalizeQueues(next, env.QUEUE));
  await sendMessage(env, chatId, formatQueuesAdded(fresh));
  await sendCurrentSchedule(env, chatId, next);
}

async function handleQueuesRemove(env: Env, chatId: number, tokens: string[]): Promise<void> {
  if (tokens.length === 0) {
    await showQueuePicker(env, chatId);
    return;
  }
  const invalid = tokens.filter((token) => !QUEUE_RE.test(token));
  if (invalid.length > 0) {
    await sendMessage(env, chatId, formatQueueInvalid(invalid.join(" ")));
    return;
  }

  await ensureChat(env, chatId);
  const stored = await getChatQueues(env, chatId);
  const current = queuesOr(env.QUEUE, stored);
  const removals = sortQueues(tokens);

  // Поки набір не заданий явно, дефолтну чергу прибрати не можна —
  // спершу додайте інші черги (набір стане явним).
  if (stored === null && removals.includes(env.QUEUE)) {
    await sendMessage(env, chatId, formatQueueIsDefault(env.QUEUE));
    return;
  }

  const removed = removals.filter((queue) => current.includes(queue));
  if (removed.length === 0) {
    await sendMessage(env, chatId, formatQueuesNotTracked(removals));
    return;
  }

  const rest = current.filter((queue) => !removed.includes(queue));
  const normalized = normalizeQueues(rest, env.QUEUE);
  const becameDefault = normalized === null;
  await setChatQueues(env, chatId, normalized);
  await sendMessage(env, chatId, formatQueuesRemoved(removed));

  const missing = removals.filter((queue) => !current.includes(queue));
  if (missing.length > 0) await sendMessage(env, chatId, formatQueuesNotTracked(missing));
  if (becameDefault) {
    await sendMessage(env, chatId, formatQueuesResetToDefault(env.QUEUE));
    await sendCurrentSchedule(env, chatId, [env.QUEUE]);
  } else {
    await sendCurrentSchedule(env, chatId, rest);
  }
}

/**
 * Натискання кнопки в інлайн-клавіатурі черг: перемкнути чергу
 * (додати/прибрати) і перезаписати повідомлення новим станом.
 */
async function handleQueueToggleCallback(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const chatId = callbackQuery.message?.chat.id;
  const data = callbackQuery.data ?? "";
  if (chatId === undefined || !data.startsWith("qt:")) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  const queue = data.slice("qt:".length);
  if (!QUEUE_RE.test(queue)) {
    await answerCallbackQuery(env, callbackQuery.id, "⚠️ Невідома черга");
    return;
  }

  // зміна набору — лише адміністратор (тист без редагування повідомлення)
  if (!isQueueAdmin(env, callbackQuery.from?.id)) {
    await answerCallbackQuery(env, callbackQuery.id, "⛔️ Черги змінює лише адміністратор");
    return;
  }

  await ensureChat(env, chatId);
  const stored = await getChatQueues(env, chatId);
  const current = queuesOr(env.QUEUE, stored);

  // Дефолтну чергу приховано за QUEUE: поки набір не заданий явно, її не прибрати.
  if (stored === null && queue === env.QUEUE) {
    await answerCallbackQuery(
      env,
      callbackQuery.id,
      "Це черга за замовчуванням — спершу додайте інші",
    );
    return;
  }

  let next: string[] | null;
  let added: boolean;
  if (current.includes(queue)) {
    added = false;
    const rest = current.filter((candidate) => candidate !== queue);
    next = rest.length > 0 ? rest : null;
  } else {
    if (current.length >= MAX_QUEUES_PER_CHAT) {
      await answerCallbackQuery(env, callbackQuery.id, `Максимум ${MAX_QUEUES_PER_CHAT} черг`);
      return;
    }
    added = true;
    next = sortQueues([...current, queue]);
  }

  const normalized = normalizeQueues(next, env.QUEUE);
  await setChatQueues(env, chatId, normalized);
  const nextQueues = queuesOr(env.QUEUE, next);
  const known = await availableQueues(env, nextQueues);
  const entries = await currentScenarioEntries(env, nextQueues);
  const text = formatQueuesMessage({
    queues: nextQueues,
    isDefault: normalized === null,
    entries,
  });
  const keyboard = queuePickerKeyboard(nextQueues, known);

  const messageId = callbackQuery.message?.message_id;
  if (messageId !== undefined) {
    await editMessageText(env, chatId, messageId, text, keyboard);
  } else {
    await sendMessage(env, chatId, text, keyboard);
  }
  await answerCallbackQuery(
    env,
    callbackQuery.id,
    added ? `✅ Додано ${queue}` : `🗑 Прибрано ${queue}`,
  );
}

/** Список черг чату + сценарії + інлайн-клавіатура вибору. */
async function showQueuePicker(env: Env, chatId: number): Promise<void> {
  await ensureChat(env, chatId);
  const stored = await getChatQueues(env, chatId);
  const queues = queuesOr(env.QUEUE, stored);
  const known = await availableQueues(env, queues);
  const entries = await currentScenarioEntries(env, queues);
  await sendMessage(
    env,
    chatId,
    formatQueuesMessage({ queues, isDefault: stored === null, entries }),
    queuePickerKeyboard(queues, known),
  );
}

/** Усі черги для кнопок: сид ZOE + накопичені з постів + поточні черги чату. */
async function availableQueues(env: Env, tracked: readonly string[]): Promise<string[]> {
  const meta = await getMeta(env);
  return sortQueues([...SEED_QUEUES, ...(meta.knownQueues ?? []), ...tracked]);
}

/** Сценарії для кожної черги з останнього поста (або null, якщо даних ще немає). */
async function currentScenarioEntries(
  env: Env,
  queues: readonly string[],
): Promise<QueueScenarioEntry[] | null> {
  const post = postFromMeta(await getMeta(env));
  if (post === null) return null;
  return queues.map((queue) => [queue, scenarioFor(post, queue)] as const);
}

/** Надсилає поточний графік для набору черг і фіксує стан чату (дедуплікація). */
async function sendCurrentSchedule(
  env: Env,
  chatId: number,
  queues: readonly string[],
): Promise<void> {
  const post = postFromMeta(await getMeta(env));
  if (post === null) return;
  const entries: QueueScenarioEntry[] = queues.map((queue) => [
    queue,
    scenarioFor(post, queue),
  ]);
  if (await sendMessage(env, chatId, formatMultiUpdate(post.title, entries))) {
    await putChatState(env, chatId, {
      posts: { [post.id]: { queues: scenarioMapFromEntries(entries) } },
      updatedAt: Date.now(),
    });
  }
}

async function handleStatus(env: Env, chatId: number): Promise<void> {
  const queues = queuesOr(env.QUEUE, await getChatQueues(env, chatId));
  const meta = await getMeta(env);
  const chatState = await getChatState(env, chatId);

  // Пріоритет — свіжі дані з meta; якщо тексту поста ще немає, беремо стан чату
  let entries: QueueScenarioEntry[] | null = null;
  const post = postFromMeta(meta);
  if (post !== null) {
    entries = queues.map((queue) => [queue, scenarioFor(post, queue)] as const);
  } else if (chatState !== null && meta.lastPostId !== null) {
    const postState = chatState.posts[meta.lastPostId];
    if (postState !== undefined) {
      entries = Object.entries(postState.queues).map(
        ([queue, scenario]) => [queue, { kind: scenario.kind, times: scenario.times }] as const,
      );
    }
  }
  const staleNote = stalePostNote(meta.lastPostTitle, new Date(), env.DIGEST_TZ || "Europe/Kyiv");

  await sendMessage(
    env,
    chatId,
    formatStatus({
      queues,
      entries,
      updatedAt: meta.updatedAt,
      staleNote,
      checkedAt: meta.lastIngestAt,
    }),
  );
}
