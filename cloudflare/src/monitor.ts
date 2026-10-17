/**
 * Цикл перевірки (запускається cron-ом щохвилини):
 * завантажити сторінку → спарсити → порівняти зі станом у KV → надіслати зміни.
 */

import { formatDigest, formatStartup, formatUpdate } from "./messages";
import {
  isBusinessPost,
  OUTAGE_URL,
  parsePage,
  scenarioFor,
  type OutagePost,
} from "./parser";
import { getChatState, getMeta, listChats, putChatState, putMeta, type Meta } from "./state";
import { sendMessage } from "./telegram";

export interface CheckSummary {
  ok: boolean;
  postId?: string;
  title?: string;
  sentTo: number[];
  skipped?: string;
}

const USER_AGENT = "ZoeOutageBot-Worker/1.0 (+https://github.com/St1rben/zoe-bot)";
const FETCH_TIMEOUT_MS = 15_000;

export async function fetchPage(url: string = OUTAGE_URL): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`zoe.com.ua HTTP ${response.status}`);
  return await response.text();
}

/** Поточна дата та час у вказаному часовому поясі (для дайджесту). */
export function timeInZone(date: Date, timeZone: string): { date: string; hm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hm: `${part("hour")}:${part("minute")}`,
  };
}

export async function runCheck(env: Env): Promise<CheckSummary> {
  const html = await fetchPage();
  const posts = await parsePage(html);
  const post = posts.find((candidate) => !isBusinessPost(candidate));
  if (post === undefined) {
    console.warn("Немає поста для населення (усе — бізнес-пости або статей немає)");
    return { ok: true, sentTo: [], skipped: "no_consumer_post" };
  }

  let meta = await getMeta(env);
  const chats = await listChats(env);
  const sentTo: number[] = [];

  if (meta.lastPostId === null) {
    // Перший запуск після деплою (KV порожній) — вітання, як у Python-версії
    for (const chat of chats) {
      await sendMessage(env, chat.chatId, formatStartup(chat.queue ?? env.QUEUE));
    }
  }

  const defaultQueue: string = env.QUEUE;
  for (const chat of chats) {
    const queue = chat.queue ?? defaultQueue;
    const scenario = scenarioFor(post, queue);
    const previous = await getChatState(env, chat.chatId);
    if (
      previous !== null &&
      previous.postId === post.id &&
      previous.queue === queue &&
      previous.scenario === scenario.kind &&
      previous.times === scenario.times
    ) {
      continue;
    }
    if (await sendMessage(env, chat.chatId, formatUpdate(post.title, queue, scenario))) {
      await putChatState(env, chat.chatId, {
        postId: post.id,
        queue,
        scenario: scenario.kind,
        times: scenario.times,
        updatedAt: Date.now(),
      });
      sentTo.push(chat.chatId);
    }
  }

  if (meta.lastPostId !== post.id) {
    meta = { ...meta, lastPostId: post.id, lastPostTitle: post.title, updatedAt: Date.now() };
    await putMeta(env, meta);
  }

  await sendDigestIfDue(env, post, new Date(), meta);
  return { ok: true, postId: post.id, title: post.title, sentTo };
}

/** Надсилає нагадування про графік, якщо зараз DIGEST_TIME у DIGEST_TZ і сьогодні ще не надсилали. */
export async function sendDigestIfDue(
  env: Env,
  post: OutagePost,
  now: Date,
  metaIn?: Meta,
): Promise<boolean> {
  const digestTime: string = env.DIGEST_TIME;
  if (!digestTime) return false;
  const timeZone: string = env.DIGEST_TZ || "Europe/Kyiv";
  const local = timeInZone(now, timeZone);
  if (local.hm !== digestTime) return false;

  const meta = metaIn ?? (await getMeta(env));
  if (meta.digestDate === local.date) return false;

  for (const chat of await listChats(env)) {
    const queue = chat.queue ?? env.QUEUE;
    await sendMessage(env, chat.chatId, formatDigest(post.title, queue, scenarioFor(post, queue)));
  }
  await putMeta(env, { ...meta, digestDate: local.date });
  console.log(`Надіслано дайджест (${digestTime} ${timeZone})`);
  return true;
}
