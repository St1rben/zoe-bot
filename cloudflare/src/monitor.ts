/**
 * Цикл перевірки: отримати сторінку (cron-ом із Cloudflare або через /ingest,
 * який штовхає маячок з українського хостингу) → спарсити → порівняти зі
 * станом у KV → надіслати зміни.
 */

import {
  formatMultiDigest,
  formatMultiUpdate,
  formatParseAlert,
  formatStartup,
} from "./messages";
import {
  hasNoSchedule,
  hasScheduleSignals,
  isBusinessPost,
  monthGenitive,
  OUTAGE_URL,
  parsePage,
  parseTitleDate,
  scenarioFor,
  sortQueues,
  type OutagePost,
  type Scenario,
} from "./parser";
import {
  getChatState,
  getMeta,
  listChats,
  putChatState,
  putMeta,
  queuesOr,
  type ChatPostState,
  type Meta,
  type QueueScenario,
} from "./state";
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
/**
 * Мітка живості /ingest для сторожа: оновлюємо не частіше ніж раз на 2 хв.
 * Повинно бути менше за WAKE_STALE_MS (3 хв) — інакше сторож бачитиме
 * «тишу» навіть тоді, коли дані нормально течуть.
 */
const INGEST_HEARTBEAT_MS = 2 * 60 * 1000;
/**
 * Стійкість до змін формату: якщо стільки перевірок підряд сторінка/пости
 * не дали жодних ознак графика — текстуємо адміну. 6 × 5 хв ≈ 30 хв.
 */
const PARSE_FAIL_ALERT_STREAK = 6;
/** Не частіше ніж раз на 12 год, щоб не спамити при тривалому збої. */
const PARSE_FAIL_ALERT_GAP_MS = 12 * 60 * 60 * 1000;

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

/** Ключ дати з заголовка поста («MM-DD»), або null якщо дату не розпізнано. */
export function postDateKey(title: string): string | null {
  const parsed = parseTitleDate(title);
  return parsed !== null ? `${parsed.month}-${parsed.day}` : null;
}

/**
 * Знаходить попередній надісланий стан чату для цього поста або (якщо zoe.com.ua
 * опублікував «ОНОВЛЕНО ГПВ» як нову статтю з новим post-ID) для попереднього
 * поста за ту саму дату графіка.
 */
function findPreviousPostState(
  post: OutagePost,
  postsState: Record<string, ChatPostState>,
  consumerPosts: readonly OutagePost[],
  meta: Meta,
): ChatPostState | undefined {
  const direct = postsState[post.id];
  if (direct !== undefined) return direct;

  const dateKey = postDateKey(post.title);
  if (dateKey === null) return undefined;

  for (const candidate of consumerPosts) {
    if (candidate.id === post.id) continue;
    const candidateState = postsState[candidate.id];
    if (candidateState !== undefined && (candidateState.dateKey ?? postDateKey(candidate.title)) === dateKey) {
      return candidateState;
    }
  }

  for (const [oldId, state] of Object.entries(postsState).reverse()) {
    if (state.dateKey === dateKey) return state;
    if (
      state.dateKey === undefined &&
      oldId === meta.lastPostId &&
      meta.lastPostTitle !== null &&
      postDateKey(meta.lastPostTitle) === dateKey
    ) {
      return state;
    }
  }

  return undefined;
}

/** Карта «черга → сценарій» — стан дедуплікації чату. */
export type ScenarioMap = Record<string, QueueScenario>;

export function scenarioMapFromEntries(
  entries: readonly (readonly [string, Scenario])[],
): ScenarioMap {
  const map: ScenarioMap = {};
  for (const [queue, scenario] of entries) {
    map[queue] = { kind: scenario.kind, times: scenario.times };
  }
  return map;
}
/** Порівнює карти сценаріїв незалежно від порядку черг. */
export function sameScenarioMap(a: ScenarioMap, b: ScenarioMap): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((key) => {
    const left = a[key];
    const right = b[key];
    return (
      left !== undefined && right !== undefined && left.kind === right.kind && left.times === right.times
    );
  });
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
 * Скільки свіжих постів для населення відстежуємо одночасно: новітній +
 * до двох попередніх. Бо правка вчерашнього/сьогоднішнього поста, що стоїть
 * ПІД новішим на сайті, інакше ніколи не потрапляє в поле зору (кейс:
 * «ОНОВЛЕНО ГПВ НА 8 ЛИСТОПАДА» опублікували о 21:59, а о 22:00 зверху
 * з'явився пост про 9-те — і правка восьмого губилася назавжди).
 */
const MAX_TRACKED_POSTS = 3;

/**
 * Обробка вже завантаженої сторінки: джерело — cron (fetch із Cloudflare)
 * або /ingest (HTML, який приніс маячок із українського хостингу).
 */
export async function processHtml(
  env: Env,
  html: string,
  source: CheckSource = "cron",
): Promise<CheckSummary> {
  let posts: OutagePost[];
  try {
    posts = await parsePage(html);
  } catch (error) {
    // Битий HTML або несподівана структура — не падати, рахувати як збій формату
    console.error("parsePage failed:", error);
    posts = [];
  }

  // Ворота безпеки: надсилаємо лише пости з ознаками графика (рядки черг
  // або «не заплановані»). Без цього зміна вёрстки розсилає всім фальшиве
  // «черги відсутні — світло не відключатимуть».
  const consumerPosts = posts
    .filter((candidate) => !isBusinessPost(candidate) && hasScheduleSignals(candidate))
    .slice(0, MAX_TRACKED_POSTS);
  const [primary] = consumerPosts;
  if (primary === undefined) {
    console.warn(`Немає постів для населення з ознаками графика (статей: ${posts.length})`);
    await handleParseFailure(env, posts.length);
    return { ok: true, sentTo: [], skipped: "no_consumer_post" };
  }

  const now = Date.now();
  let meta = await getMeta(env);
  let metaDirty = false;

  // Мітка живості маячка: пишемо не частіше ніж раз на 2 хв (KV: 1 тис. записів/добу)
  const lastIngestAt = meta.lastIngestAt ?? null;
  if (source === "ingest" && (lastIngestAt === null || now - lastIngestAt > INGEST_HEARTBEAT_MS)) {
    meta.lastIngestAt = now;
    metaDirty = true;
  }

  // Успішний розбір — скидаємо серію збоїв формату
  if ((meta.parseFailStreak ?? 0) > 0) {
    meta.parseFailStreak = 0;
    metaDirty = true;
  }

  // Сигнатури всіх відстежуваних постів — правки бачимо навіть під новішим
  const sigs = new Map<string, string>();
  for (const post of consumerPosts) {
    sigs.set(post.id, await contentSignature(post));
  }

  // Відомі сигнатури: у міграції з v1.8.1 сіється з lastPostSig, щоб
  // перший інгест після деплою не дав ложного «оновлено, без змін»
  const knownSigs: Record<string, string> =
    meta.recentSigs ??
    (meta.lastPostId !== null && meta.lastPostSig !== null
      ? { [meta.lastPostId]: meta.lastPostSig }
      : {});
  const changedPosts = consumerPosts.filter(
    (post) => knownSigs[post.id] !== sigs.get(post.id),
  );

  if (meta.lastPostId !== null && changedPosts.length === 0) {
    // Контент усіх постів не змінювався — не перебираємо чати, лише дайджест і «бейкон».
    const digestSent = await sendDigestIfDue(env, primary, new Date(now), meta);
    if (metaDirty && !digestSent) await putMeta(env, meta);
    return { ok: true, postId: primary.id, title: primary.title, sentTo: [], skipped: "unchanged" };
  }

  const chats = await listChats(env);
  const sentTo: number[] = [];
  const isFirstRun = meta.lastPostId === null;

  if (isFirstRun) {
    // Перший запуск після деплою (KV порожній) — вітання, як у Python-версії
    for (const chat of chats) {
      await sendMessage(env, chat.chatId, formatStartup(queuesOr(env.QUEUE, chat.queues)));
    }
  }

  for (const chat of chats) {
    const queues = queuesOr(env.QUEUE, chat.queues);
    const previous = await getChatState(env, chat.chatId);
    const previousPostsState: Record<string, ChatPostState> = { ...(previous?.posts ?? {}) };
    const postsState: Record<string, ChatPostState> = { ...previousPostsState };
    let chatDirty = false;

    for (const post of changedPosts) {
      const entries: (readonly [string, Scenario])[] = queues.map((queue) => [
        queue,
        scenarioFor(post, queue),
      ]);
      const scenarioMap = scenarioMapFromEntries(entries);
      const dateKey = postDateKey(post.title);

      // Якщо вище на сторінці вже є свіжіший пост за цю саму дату (наприклад,
      // вийшло одразу кілька «ОНОВЛЕНО ГПВ НА 11 ЛИСТОПАДА»), нижній пост за ту
      // саму добу вже застарів — тихо фіксуємо його стан і не надсилаємо.
      const supersededByNewerSameDay =
        dateKey !== null &&
        consumerPosts[0]?.id !== post.id &&
        consumerPosts.some(
          (candidate) =>
            candidate.id !== post.id &&
            consumerPosts.indexOf(candidate) < consumerPosts.indexOf(post) &&
            postDateKey(candidate.title) === dateKey,
        );
      if (supersededByNewerSameDay) {
        postsState[post.id] = { queues: scenarioMap, dateKey };
        chatDirty = true;
        continue;
      }

      const prevPost = findPreviousPostState(post, previousPostsState, consumerPosts, meta);

      let messageText: string | null = null;
      if (prevPost !== undefined) {
        // Правка того самого поста або новий пост «ОНОВЛЕНО ГПВ» за ту саму дату:
        // якщо для черг цього чату нічого не змінилося — мовчимо, лише оновлюємо стан.
        if (sameScenarioMap(prevPost.queues, scenarioMap)) {
          if (postsState[post.id] === undefined || postsState[post.id]?.dateKey !== dateKey) {
            postsState[post.id] = { queues: scenarioMap, dateKey };
            chatDirty = true;
          }
        } else {
          messageText = formatMultiUpdate(post.title, entries, prevPost.queues);
        }
      } else if (isFirstRun && post.id === primary.id) {
        // Перший запуск: вітання вже пішло, показуємо новітній пост
        messageText = formatMultiUpdate(post.title, entries);
      } else if (
        !isFirstRun &&
        (post.id === primary.id || knownSigs[post.id] !== undefined)
      ) {
        // Новий верхній пост за іншу дату — або правка поста без попереднього стану
        messageText = formatMultiUpdate(post.title, entries);
      } else {
        // Пост уперше потрапив у трекінг нижче верхнього — тихо реєструємо
        postsState[post.id] = { queues: scenarioMap, dateKey };
        chatDirty = true;
      }

      if (messageText !== null && (await sendMessage(env, chat.chatId, messageText))) {
        postsState[post.id] = { queues: scenarioMap, dateKey };
        chatDirty = true;
        if (!sentTo.includes(chat.chatId)) sentTo.push(chat.chatId);
      }
    }

    // Тримаємо стан лише для постів, які ще відстежуються
    for (const key of Object.keys(postsState)) {
      if (!consumerPosts.some((p) => p.id === key)) delete postsState[key];
    }

    if (chatDirty) {
      await putChatState(env, chat.chatId, { posts: postsState, updatedAt: Date.now() });
    }
  }

  // Контент змінився (хоча б одного з відстежуваних постів) — фіксуємо метадані
  const recentSigs: Record<string, string> = {};
  for (const post of consumerPosts) {
    const sig = sigs.get(post.id);
    if (sig !== undefined) recentSigs[post.id] = sig;
  }
  meta = {
    ...meta,
    lastPostId: primary.id,
    lastPostTitle: primary.title,
    lastPostText: primary.text,
    updatedAt: now,
    lastPostSig: sigs.get(primary.id) ?? null,
    knownQueues: sortQueues([
      ...(meta.knownQueues ?? []),
      ...consumerPosts.flatMap((post) => Object.keys(post.queues)),
    ]),
    recentSigs,
  };
  const digestSent = await sendDigestIfDue(env, primary, new Date(now), meta);
  if (!digestSent) await putMeta(env, meta);

  return { ok: true, postId: primary.id, title: primary.title, sentTo };
}

/**
 * Розбір не дав ознак графика. Рахуємо серію збоїв; коли вона затягнулась —
 * раз на 12 год текстуємо адміну (ADMIN_IDS, інакше CHAT_ID). Сама обробка
 * збою теж захищена: помилка тут не повинна валити /ingest.
 */
async function handleParseFailure(env: Env, postsCount: number): Promise<void> {
  try {
    const meta = await getMeta(env);
    const streak = (meta.parseFailStreak ?? 0) + 1;
    const now = Date.now();
    const next: Meta = { ...meta, parseFailStreak: streak };

    const dueAlert =
      streak >= PARSE_FAIL_ALERT_STREAK && now - (meta.lastParseAlertAt ?? 0) > PARSE_FAIL_ALERT_GAP_MS;
    if (dueAlert) {
      next.lastParseAlertAt = now;
      for (const chatId of alertTargets(env)) {
        await sendMessage(env, chatId, formatParseAlert(postsCount, streak));
      }
    }
    await putMeta(env, next);
  } catch (error) {
    console.error("parse-failure handling failed:", error);
  }
}

/** Куди слати службові алерти: адміни з ADMIN_IDS, інакше CHAT_ID. */
export function alertTargets(env: Env): number[] {
  const ids = (env.ADMIN_IDS ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id !== 0);
  if (ids.length > 0) return ids;
  const chatId = env.CHAT_ID ? Number(env.CHAT_ID) : NaN;
  return Number.isFinite(chatId) ? [chatId] : [];
}

/** Надсилає нагадування про графік, якщо DIGEST_TIME вже настав і сьогодні ще не надсилали. */
export async function sendDigestIfDue(
  env: Env,
  post: OutagePost,
  now: Date,
  metaIn?: Meta,
): Promise<boolean> {
  const digestTime: string = env.DIGEST_TIME;
  const digestMinutes = parseHM(digestTime);
  if (digestMinutes === null) return false;
  const timeZone: string = env.DIGEST_TZ || "Europe/Kyiv";
  const local = timeInZone(now, timeZone);
  // «Перше попадання після DIGEST_TIME»: точна рівність хвилини пропускала
  // дайджест, коли /ingest не приходив рівно в цю хвилину
  const nowMinutes = Number(local.hm.slice(0, 2)) * 60 + Number(local.hm.slice(3, 5));
  if (nowMinutes < digestMinutes) return false;

  const meta = metaIn ?? (await getMeta(env));
  if (meta.digestDate === local.date) return false;

  for (const chat of await listChats(env)) {
    const queues = queuesOr(env.QUEUE, chat.queues);
    const entries = queues.map((queue) => [queue, scenarioFor(post, queue)] as const);
    await sendMessage(env, chat.chatId, formatMultiDigest(post.title, entries));
  }
  await putMeta(env, { ...meta, digestDate: local.date });
  console.log(`Надіслано дайджест (${digestTime} ${timeZone})`);
  return true;
}

/** «20:15» → 1215 хв від півночі; некоректне/порожнє значення → null (вимкнено). */
export function parseHM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
