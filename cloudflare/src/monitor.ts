/**
 * Цикл перевірки: отримати сторінку (cron-ом із Cloudflare або через /ingest,
 * який штовхає маячок з українського хостингу) → спарсити → порівняти зі
 * станом у KV → надіслати зміни.
 */

import { formatDigest, formatStartup, formatUpdate } from "./messages";
import {
  isBusinessPost,
  monthGenitive,
  OUTAGE_URL,
  parsePage,
  parseTitleDate,
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

export type CheckSource = "cron" | "ingest";

const USER_AGENT = "ZoeOutageBot-Worker/1.0 (+https://github.com/St1rben/zoe-bot)";
const FETCH_TIMEOUT_MS = 15_000;
/** Як часто оновлювати meta.lastIngestAt, щоб не палити write-ліміт KV і не «брехати» сторожу. */
const INGEST_HEARTBEAT_MS = 5 * 60 * 1000;

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

/**
 * Попередження для /status, коли найсвіжіший пост не за сьогодні:
 * графік на поточний день ще не публікували — інакше старі вікна
 * виглядають як «поточний стан».
 */
export function stalePostNote(title: string | null, now: Date, timeZone: string): string | null {
  if (title === null) return null;
  const postDate = parseTitleDate(title);
  if (postDate === null) return null;

  const todayParts = timeInZone(now, timeZone).date.split("-");
  const month = Number(todayParts[1] ?? "0");
  const day = Number(todayParts[2] ?? "0");
  // Пост за сьогодні або на майбутню дату — попередження не потрібне.
  if (postDate.month > month || (postDate.month === month && postDate.day >= day)) return null;

  return (
    `⚠️ На ${day} ${monthGenitive(month)} графік для населення не публікували — ` +
    `відключень на сьогодні не оголошено. Нижче — дані за ${postDate.day} ${monthGenitive(postDate.month)}.`
  );
}

export async function runCheck(env: Env): Promise<CheckSummary> {
  const html = await fetchPage();
  return await processHtml(env, html, "cron");
}

/** SHA-256 (hex) від id + заголовка + тексту поста — «відбиток» контенту. */
export async function contentSignature(post: OutagePost): Promise<string> {
  const bytes = new TextEncoder().encode(`${post.id}\n${post.title}\n${post.text}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Обробка вже завантаженої сторінки: джерело — cron (fetch із Cloudflare)
 * або /ingest (HTML, який приніс маячок із українського хостингу).
 */
export async function processHtml(
  env: Env,
  html: string,
  source: CheckSource = "cron",
): Promise<CheckSummary> {
  const posts = await parsePage(html);
  const post = posts.find((candidate) => !isBusinessPost(candidate));
  if (post === undefined) {
    console.warn("Немає поста для населення (усе — бізнес-пости або статей немає)");
    return { ok: true, sentTo: [], skipped: "no_consumer_post" };
  }

  const now = Date.now();
  let meta = await getMeta(env);
  let metaDirty = false;

  // Мітка живості маячка: пишемо не частіше ніж раз на 30 хв (KV: 1 тис. записів/добу)
  const lastIngestAt = meta.lastIngestAt ?? null;
  if (source === "ingest" && (lastIngestAt === null || now - lastIngestAt > INGEST_HEARTBEAT_MS)) {
    meta.lastIngestAt = now;
    metaDirty = true;
  }

  const signature = await contentSignature(post);
  if (meta.lastPostId !== null && meta.lastPostSig === signature) {
    // Пост не змінювався — не перебираємо чати, лише дайджест і «бейкон» маячка.
    const digestSent = await sendDigestIfDue(env, post, new Date(now), meta);
    if (metaDirty && !digestSent) await putMeta(env, meta);
    return { ok: true, postId: post.id, title: post.title, sentTo: [], skipped: "unchanged" };
  }

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

  // Контент змінився — фіксуємо метадані (навіть якщо postId той самий: правки в тому ж пості).
  meta = {
    ...meta,
    lastPostId: post.id,
    lastPostTitle: post.title,
    lastPostText: post.text,
    updatedAt: now,
    lastPostSig: signature,
  };
  const digestSent = await sendDigestIfDue(env, post, new Date(now), meta);
  if (!digestSent) await putMeta(env, meta);

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
