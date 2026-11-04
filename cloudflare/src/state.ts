/**
 * Стан у Workers KV:
 *   chat:{id}        → підписка чату; набір черг зберігається в metadata.queues
 *                      (старий формат metadata.queue — одна черга — читається
 *                      та мігрує ліниво)
 *   chat_state:{id}  → останній надісланий стан для чату (для дедуплікації)
 *   meta             → глобальні метадані: останній пост, дата дайджесту,
 *                      відомі черги з постів
 */

import { parseQueueLines, type OutagePost, type ScenarioKind } from "./parser";

export const CHAT_PREFIX = "chat:";
export const CHAT_STATE_PREFIX = "chat_state:";
export const META_KEY = "meta";

/** metadata для chat:{id}: старий формат (queue) і новий (queues). */
interface ChatMetadata {
  queue?: string | null;
  queues?: string[] | null;
}

export interface ChatSubscription {
  chatId: number;
  /** null — використовувати чергу за замовчуванням (QUEUE) */
  queues: string[] | null;
}

/** Сценарій однієї черги на момент останнього надісланого повідомлення. */
export interface QueueScenario {
  kind: ScenarioKind;
  times: string | null;
}

export interface ChatState {
  postId: string;
  /** Сценарій на кожну відстежувану чергу — дедуплікація за сукупністю. */
  queues: Record<string, QueueScenario>;
  updatedAt: number;
}

export interface Meta {
  lastPostId: string | null;
  lastPostTitle: string | null;
  /** Текст останнього поста — щоб /start міг показати графік без повторного HTML. */
  lastPostText: string | null;
  updatedAt: number | null;
  digestDate: string | null;
  /** SHA-256 контенту останнього поста — пропуск незмінних перевірок. */
  lastPostSig: string | null;
  /** Час останнього прийнятого /ingest (оновлюється не частіше ніж раз на 5 хв). */
  lastIngestAt: number | null;
  /** Час останнього «пробудження» GitHub-запуску сторожем (cron воркера). */
  lastDispatchAt?: number | null;
  /** Черги, зустрінуті в постах (для кнопок вибору — розширюють SEED_QUEUES). */
  knownQueues: string[] | null;
  /** Серія /ingest без ознак графика (зміна формату сайту) — для алерта адміну. */
  parseFailStreak?: number;
  /** Час останнього алерта про збій формату (не частіше ніж раз на 12 год). */
  lastParseAlertAt?: number;
}

export function emptyMeta(): Meta {
  return {
    lastPostId: null,
    lastPostTitle: null,
    lastPostText: null,
    updatedAt: null,
    digestDate: null,
    lastPostSig: null,
    lastIngestAt: null,
    lastDispatchAt: null,
    knownQueues: null,
  };
}

/** Черги, які відстежує чат: власний вибір або дефолтна. */
export function queuesOr(defaultQueue: string, queues: string[] | null): string[] {
  return queues !== null && queues.length > 0 ? queues : [defaultQueue];
}

/** Відновлює останній пост із метаданих (без повторного fetch/parse HTML). */
export function postFromMeta(meta: Meta): OutagePost | null {
  if (meta.lastPostId === null || !meta.lastPostText) return null;
  return {
    id: meta.lastPostId,
    title: meta.lastPostTitle ?? "",
    text: meta.lastPostText,
    queues: parseQueueLines(meta.lastPostText),
  };
}

export async function getMeta(env: Env): Promise<Meta> {
  const raw = await env.STATE.get<Meta>(META_KEY, "json");
  return raw ?? emptyMeta();
}

export async function putMeta(env: Env, meta: Meta): Promise<void> {
  await env.STATE.put(META_KEY, JSON.stringify(meta));
}

export async function listChats(env: Env): Promise<ChatSubscription[]> {
  const listed = await env.STATE.list<ChatMetadata | null>({ prefix: CHAT_PREFIX });
  const chats: ChatSubscription[] = listed.keys.map((key) => ({
    chatId: Number(key.name.slice(CHAT_PREFIX.length)),
    queues: queuesFromMetadata(key.metadata),
  }));
  // CHAT_ID із секретів працює як "віртуальна" підписка: писати в KV не потрібно
  const defaultChatId = env.CHAT_ID ? Number(env.CHAT_ID) : null;
  if (
    defaultChatId !== null &&
    Number.isFinite(defaultChatId) &&
    !chats.some((chat) => chat.chatId === defaultChatId)
  ) {
    chats.unshift({ chatId: defaultChatId, queues: null });
  }
  return chats;
}

/** Нормалізує metadata чату: новий формат (queues) або старий (queue → [queue]). */
function queuesFromMetadata(metadata: ChatMetadata | null | undefined): string[] | null {
  if (metadata === null || metadata === undefined) return null;
  if (Array.isArray(metadata.queues)) {
    return metadata.queues.length > 0 ? metadata.queues : null;
  }
  if (typeof metadata.queue === "string") return [metadata.queue];
  return null;
}

export async function ensureChat(env: Env, chatId: number): Promise<void> {
  const existing = await env.STATE.getWithMetadata(CHAT_PREFIX + chatId);
  if (existing.value === null) await env.STATE.put(CHAT_PREFIX + chatId, "1");
}

/** Набір черг чату: queues з metadata або міграція старого metadata.queue. */
export async function getChatQueues(env: Env, chatId: number): Promise<string[] | null> {
  const existing = await env.STATE.getWithMetadata<ChatMetadata | null>(CHAT_PREFIX + chatId);
  return queuesFromMetadata(existing.metadata);
}

/** queues = null або [] — повернутись до черги за замовчуванням. */
export async function setChatQueues(
  env: Env,
  chatId: number,
  queues: string[] | null,
): Promise<void> {
  const normalized = queues !== null && queues.length > 0 ? queues : null;
  await env.STATE.put(CHAT_PREFIX + chatId, "1", { metadata: { queues: normalized } });
}

export async function getChatState(env: Env, chatId: number): Promise<ChatState | null> {
  const raw = await env.STATE.get<
    ChatState & { queue?: string; scenario?: ScenarioKind; times?: string | null }
  >(CHAT_STATE_PREFIX + chatId, "json");
  if (raw === null) return null;
  if (raw.queues !== undefined) {
    return { postId: raw.postId, queues: raw.queues, updatedAt: raw.updatedAt };
  }
  // Міграція старого формату (одна черга на чат)
  if (typeof raw.queue === "string" && raw.scenario !== undefined) {
    return {
      postId: raw.postId,
      queues: { [raw.queue]: { kind: raw.scenario, times: raw.times ?? null } },
      updatedAt: raw.updatedAt,
    };
  }
  return null;
}

export async function putChatState(env: Env, chatId: number, state: ChatState): Promise<void> {
  await env.STATE.put(CHAT_STATE_PREFIX + chatId, JSON.stringify(state));
}
