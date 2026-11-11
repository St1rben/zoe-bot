/**
 * Збереження стану адресних відключень (@zoe_alarm) у Workers KV.
 * Використовує виключно власний префікс `alarm:*` і не перетинається з ГПВ.
 */

import type { AlarmRow, TrackedAddress } from "./address";

export const ALARM_ADDR_PREFIX = "alarm:addr:";
export const ALARM_CHAT_STATE_PREFIX = "alarm:chat:";
export const ALARM_META_KEY = "alarm:meta";

export interface ActiveAlarmPost {
  postId: string;
  fileName: string;
  caption: string;
  replyToPostId: string | null;
  isPreAnnouncement: boolean;
  publishedAt: string;
  rows: AlarmRow[];
  ingestedAt: number;
}

export interface AlarmMeta {
  /** Останні оброблені postId з t.me/zoe_alarm (до 200 шт.) */
  processedPostIds: string[];
  /** Активні (ще не відновлені) пости ЗМЕМ за postId */
  activePosts: Record<string, ActiveAlarmPost>;
  /** Час останньої перевірки каналу */
  lastCheckAt: number | null;
  /** Час останнього workflow_dispatch для zoe-alarm.yml */
  lastDispatchAt?: number | null;
  updatedAt: number | null;
}

export interface ActiveChatIncident {
  postId: string;
  /** Усі postId, у яких фігурував цей самий інцидент (для кумулятивних файлів і реплаїв) */
  relatedPostIds?: string[];
  fileName: string;
  addressId: string;
  streetDisplay: string;
  houseDisplay: string;
  tableStreet: string;
  reason: string;
  isPreAnnouncement: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  notifiedAt: number;
  updatedAt: number;
}

export interface AlarmChatState {
  updatedAt: number;
  /** Активні інциденти чату за ключем `<addressId>::<postId>` */
  incidents: Record<string, ActiveChatIncident>;
  /** postId, за якими в цьому чаті вже відпрацьовано відновлення (щоб старі кумулятивні пости не спрацьовували повторно) */
  resolvedPostIds?: string[];
}

export function emptyAlarmMeta(): AlarmMeta {
  return {
    processedPostIds: [],
    activePosts: {},
    lastCheckAt: null,
    updatedAt: null,
  };
}

export async function getAlarmMeta(env: Env): Promise<AlarmMeta> {
  const raw = await env.STATE.get<AlarmMeta>(ALARM_META_KEY, "json");
  return raw ?? emptyAlarmMeta();
}

export async function putAlarmMeta(env: Env, meta: AlarmMeta): Promise<void> {
  await env.STATE.put(ALARM_META_KEY, JSON.stringify(meta));
}

export async function getChatAddresses(env: Env, chatId: number): Promise<TrackedAddress[]> {
  const raw = await env.STATE.get<TrackedAddress[]>(ALARM_ADDR_PREFIX + chatId, "json");
  return Array.isArray(raw) ? raw : [];
}

export async function setChatAddresses(
  env: Env,
  chatId: number,
  addresses: readonly TrackedAddress[],
): Promise<void> {
  if (addresses.length === 0) {
    await env.STATE.delete(ALARM_ADDR_PREFIX + chatId);
    return;
  }
  await env.STATE.put(ALARM_ADDR_PREFIX + chatId, JSON.stringify(addresses));
}

export async function listAlarmChatIds(env: Env): Promise<number[]> {
  const listed = await env.STATE.list({ prefix: ALARM_ADDR_PREFIX });
  const ids: number[] = [];
  for (const key of listed.keys) {
    const id = Number(key.name.slice(ALARM_ADDR_PREFIX.length));
    if (Number.isFinite(id) && id !== 0) {
      ids.push(id);
    }
  }
  return ids;
}

export async function getAlarmChatState(env: Env, chatId: number): Promise<AlarmChatState> {
  const raw = await env.STATE.get<AlarmChatState>(ALARM_CHAT_STATE_PREFIX + chatId, "json");
  if (raw === null || typeof raw.incidents !== "object" || raw.incidents === null) {
    return { updatedAt: 0, incidents: {} };
  }
  return raw;
}

export async function putAlarmChatState(
  env: Env,
  chatId: number,
  state: AlarmChatState,
): Promise<void> {
  const hasIncidents = Object.keys(state.incidents).length > 0;
  const hasResolved = Array.isArray(state.resolvedPostIds) && state.resolvedPostIds.length > 0;
  if (!hasIncidents && !hasResolved) {
    await env.STATE.delete(ALARM_CHAT_STATE_PREFIX + chatId);
    return;
  }
  await env.STATE.put(ALARM_CHAT_STATE_PREFIX + chatId, JSON.stringify(state));
}
