/**
 * Стан у Workers KV:
 *   chat:{id}        → підписка чату; черга зберігається в metadata.queue
 *   chat_state:{id}  → останній надісланий стан для чату (для дедуплікації)
 *   meta             → глобальні метадані: останній пост, дата дайджесту
 */

import type { ScenarioKind } from "./parser";

export const CHAT_PREFIX = "chat:";
export const CHAT_STATE_PREFIX = "chat_state:";
export const META_KEY = "meta";

export interface ChatSubscription {
  chatId: number;
  /** null — використовувати чергу за замовчуванням (QUEUE) */
  queue: string | null;
}

export interface ChatState {
  postId: string;
  queue: string;
  scenario: ScenarioKind;
  times: string | null;
  updatedAt: number;
}

export interface Meta {
  lastPostId: string | null;
  lastPostTitle: string | null;
  updatedAt: number | null;
  digestDate: string | null;
}

export function emptyMeta(): Meta {
  return { lastPostId: null, lastPostTitle: null, updatedAt: null, digestDate: null };
}

export async function getMeta(env: Env): Promise<Meta> {
  const raw = await env.STATE.get<Meta>(META_KEY, "json");
  return raw ?? emptyMeta();
}

export async function putMeta(env: Env, meta: Meta): Promise<void> {
  await env.STATE.put(META_KEY, JSON.stringify(meta));
}

export async function listChats(env: Env): Promise<ChatSubscription[]> {
  const listed = await env.STATE.list<{ queue?: string | null } | null>({ prefix: CHAT_PREFIX });
  const chats: ChatSubscription[] = listed.keys.map((key) => ({
    chatId: Number(key.name.slice(CHAT_PREFIX.length)),
    queue: key.metadata?.queue ?? null,
  }));
  // CHAT_ID із секретів працює як "віртуальна" підписка: писати в KV не потрібно
  const defaultChatId = env.CHAT_ID ? Number(env.CHAT_ID) : null;
  if (
    defaultChatId !== null &&
    Number.isFinite(defaultChatId) &&
    !chats.some((chat) => chat.chatId === defaultChatId)
  ) {
    chats.unshift({ chatId: defaultChatId, queue: null });
  }
  return chats;
}

export async function ensureChat(env: Env, chatId: number): Promise<void> {
  const existing = await env.STATE.getWithMetadata(CHAT_PREFIX + chatId);
  if (existing.value === null) await env.STATE.put(CHAT_PREFIX + chatId, "1");
}

export async function getChatQueue(env: Env, chatId: number): Promise<string | null> {
  const existing = await env.STATE.getWithMetadata<{ queue?: string | null } | null>(
    CHAT_PREFIX + chatId,
  );
  return existing.metadata?.queue ?? null;
}

/** queue = null — повернутись до черги за замовчуванням. */
export async function setChatQueue(env: Env, chatId: number, queue: string | null): Promise<void> {
  await env.STATE.put(CHAT_PREFIX + chatId, "1", { metadata: { queue } });
}

export async function getChatState(env: Env, chatId: number): Promise<ChatState | null> {
  return await env.STATE.get<ChatState>(CHAT_STATE_PREFIX + chatId, "json");
}

export async function putChatState(env: Env, chatId: number, state: ChatState): Promise<void> {
  await env.STATE.put(CHAT_STATE_PREFIX + chatId, JSON.stringify(state));
}
