/**
 * Моніторинг адресних відключень (@zoe_alarm) та обробка команди /address.
 * Повністю ізольований від логіки ГПВ (monitor.ts).
 */

import {
  MAX_ADDRESSES_PER_CHAT,
  matchAddressRow,
  parseAddressInput,
  type AlarmRow,
  type TrackedAddress,
} from "./address";
import {
  addressHash,
  addressListKeyboard,
  formatAddressAdded,
  formatAddressAlreadyTracked,
  formatAddressInvalid,
  formatAddressLimit,
  formatAddressMenu,
  formatAddressNotFound,
  formatAddressRemoved,
  formatAlarmNew,
  formatAlarmRestored,
  formatAlarmTimeChanged,
  type AddressStatusEntry,
} from "./alarmMessages";
import {
  getAlarmChatState,
  getAlarmMeta,
  getChatAddresses,
  listAlarmChatIds,
  putAlarmChatState,
  putAlarmMeta,
  setChatAddresses,
  type ActiveAlarmPost,
  type ActiveChatIncident,
  type AlarmMeta,
} from "./alarmState";
import { formatQueueForbidden } from "./messages";
import {
  answerCallbackQuery,
  editMessageText,
  sendMessage,
  type TelegramCallbackQuery,
} from "./telegram";

export interface IngestAlarmPost {
  postId: string;
  fileName: string;
  caption: string;
  replyToPostId?: string | null;
  publishedAt?: string;
  rows: AlarmRow[];
}

export interface IngestRestoredReply {
  postId: string;
  replyToPostId: string;
  text: string;
  publishedAt?: string;
}

export interface AlarmIngestPayload {
  newPosts?: IngestAlarmPost[];
  restoredReplies?: IngestRestoredReply[];
  /** Якщо true — оновити стан без розсилки повідомлень у чати (первинна ініціалізація). */
  silentSeed?: boolean;
}

export interface AlarmIngestSummary {
  ok: boolean;
  newPostsCount: number;
  restoredRepliesCount: number;
  activePostsCount: number;
  notificationsSent: number;
}

const MAX_PROCESSED_IDS = 250;
const MAX_ACTIVE_POSTS = 60;
/** Після скількох годин від планового часу завершення вважати запис застарілим, якщо не було реплаю. */
const EXPIRY_GRACE_MS = 12 * 3600 * 1000;

export function isPreAnnouncementCaption(caption: string): boolean {
  return /буде\s+знеструмлено|повідомлено\s+додатково/i.test(caption);
}

/**
 * Парсить дату "DD.MM.YYYY" і час "HH-MM" або "HH:MM" у приблизний UTC timestamp
 * (для перевірки застарівання записів).
 */
export function parseOutageDateTimeMs(dateStr: string, timeStr: string): number | null {
  const dm = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(dateStr.trim());
  if (dm === null) return null;
  const day = Number(dm[1]);
  const month = Number(dm[2]);
  const year = Number(dm[3]);

  const tm = /^(\d{1,2})[-:](\d{2})$/.exec(timeStr.trim());
  const hour = tm !== null ? Number(tm[1]) : 23;
  const minute = tm !== null ? Number(tm[2]) : 59;

  // Київський час: UTC+2 (або UTC+3 влітку). Для вікна застарівання 12 год похибка в 1 год не критична.
  return Date.UTC(year, month - 1, day, hour - 2, minute);
}

export function isIncidentExpired(endDate: string, endTime: string, nowMs: number): boolean {
  const endMs = parseOutageDateTimeMs(endDate, endTime);
  if (endMs === null) return false;
  return nowMs - endMs > EXPIRY_GRACE_MS;
}

function isPostExpired(post: ActiveAlarmPost, nowMs: number): boolean {
  if (post.rows.length === 0) return true;
  return post.rows.every((row) => isIncidentExpired(row.endDate, row.endTime, nowMs));
}

/**
 * Обробляє пакет нових постів та реплаїв із каналу t.me/zoe_alarm.
 */
export async function processAlarmIngest(
  env: Env,
  payload: AlarmIngestPayload,
): Promise<AlarmIngestSummary> {
  const now = Date.now();
  const meta = await getAlarmMeta(env);
  const newPosts = payload.newPosts ?? [];
  const restoredReplies = payload.restoredReplies ?? [];
  const silent = payload.silentSeed === true;

  // Якщо база ще порожня (перший запуск узагалі) — не спамимо старими постами,
  // а тихо фіксуємо поточний стан, якщо не передано явний silentSeed: false.
  const isFirstEverRun = meta.lastCheckAt === null && meta.processedPostIds.length === 0;
  const shouldSilenceNew = silent || isFirstEverRun;

  // Map: oldPostId -> newPost (коли новий пост замінює старий через reply або однаковий fileName)
  const supersededBy = new Map<string, ActiveAlarmPost>();
  // Map: targetPostId -> replyPostId (коли прийшло "Електропостачання відновлено.")
  const restoredBy = new Map<string, string>();

  const processedSet = new Set(meta.processedPostIds);

  for (const rawPost of newPosts) {
    if (!rawPost.postId || !Array.isArray(rawPost.rows)) continue;
    const activePost: ActiveAlarmPost = {
      postId: String(rawPost.postId),
      fileName: rawPost.fileName ?? "",
      caption: rawPost.caption ?? "",
      replyToPostId: rawPost.replyToPostId ? String(rawPost.replyToPostId) : null,
      isPreAnnouncement: isPreAnnouncementCaption(rawPost.caption ?? ""),
      publishedAt: rawPost.publishedAt ?? new Date(now).toISOString(),
      rows: rawPost.rows,
      ingestedAt: now,
    };

    // 1. Якщо це реплай з новим файлом (напр. "Електропостачання відновлено частково")
    if (activePost.replyToPostId !== null && meta.activePosts[activePost.replyToPostId] !== undefined) {
      supersededBy.set(activePost.replyToPostId, activePost);
      delete meta.activePosts[activePost.replyToPostId];
    }

    // 2. Якщо вже є активний пост із такою самою назвою файлу (напр. вечірній анонс -> ранковий старт)
    if (activePost.fileName) {
      for (const [existingId, existingPost] of Object.entries(meta.activePosts)) {
        if (existingId !== activePost.postId && existingPost.fileName === activePost.fileName) {
          supersededBy.set(existingId, activePost);
          delete meta.activePosts[existingId];
        }
      }
    }

    meta.activePosts[activePost.postId] = activePost;
    processedSet.add(activePost.postId);
  }

  for (const reply of restoredReplies) {
    if (!reply.postId || !reply.replyToPostId) continue;
    processedSet.add(String(reply.postId));
    const targetId = String(reply.replyToPostId);
    if (/відновлено/i.test(reply.text) && !/частково/i.test(reply.text)) {
      restoredBy.set(targetId, String(reply.postId));
      delete meta.activePosts[targetId];
    }
  }

  // Очищуємо застарілі пости
  for (const [id, post] of Object.entries(meta.activePosts)) {
    if (isPostExpired(post, now)) {
      delete meta.activePosts[id];
    }
  }

  // Обмежуємо кількість активних постів
  const activeEntries = Object.entries(meta.activePosts).sort(
    ([a], [b]) => Number(b) - Number(a),
  );
  meta.activePosts = Object.fromEntries(activeEntries.slice(0, MAX_ACTIVE_POSTS));
  meta.processedPostIds = [...processedSet].slice(-MAX_PROCESSED_IDS);
  meta.lastCheckAt = now;
  meta.updatedAt = now;

  await putAlarmMeta(env, meta);

  let notificationsSent = 0;
  const chatIds = await listAlarmChatIds(env);

  for (const chatId of chatIds) {
    const addresses = await getChatAddresses(env, chatId);
    if (addresses.length === 0) continue;

    const chatState = await getAlarmChatState(env, chatId);
    const nextIncidents: Record<string, ActiveChatIncident> = { ...chatState.incidents };
    const resolvedSet = new Set<string>(chatState.resolvedPostIds ?? []);
    let stateChanged = false;

    // Крок 1: перевіряємо вже відомі активні інциденти чату на відновлення або заміну поста
    for (const [incKey, inc] of Object.entries(nextIncidents)) {
      const allRelatedIds = [inc.postId, ...(inc.relatedPostIds ?? [])];

      // A) Прямий реплай "Електропостачання відновлено." на будь-який із пов'язаних postId
      let restoreReplyId: string | undefined;
      for (const relId of allRelatedIds) {
        const candidate = restoredBy.get(relId);
        if (candidate !== undefined) {
          restoreReplyId = candidate;
          break;
        }
      }

      if (restoreReplyId !== undefined) {
        delete nextIncidents[incKey];
        for (const relId of allRelatedIds) {
          resolvedSet.add(relId);
        }
        stateChanged = true;
        if (!silent) {
          const ok = await sendMessage(
            env,
            chatId,
            formatAlarmRestored({
              address: { street: inc.streetDisplay, house: inc.houseDisplay },
              replyPostId: restoreReplyId,
            }),
          );
          if (ok) notificationsSent += 1;
        }
        continue;
      }

      // B) Пост було замінено новішим постом (часткове відновлення або старт робіт за тим самим файлом)
      let replacement: ActiveAlarmPost | undefined;
      for (const relId of allRelatedIds) {
        const candidate = supersededBy.get(relId);
        if (candidate !== undefined) {
          replacement = candidate;
          break;
        }
      }

      if (replacement !== undefined) {
        const trackedAddr: TrackedAddress = addresses.find((a) => a.id === inc.addressId) ?? {
          id: inc.addressId,
          street: inc.streetDisplay,
          house: inc.houseDisplay,
        };
        const matchingRow = replacement.rows.find((row) => matchAddressRow(trackedAddr, row));

        delete nextIncidents[incKey];
        stateChanged = true;

        if (matchingRow === undefined) {
          for (const relId of allRelatedIds) {
            resolvedSet.add(relId);
          }
          // У новому файлі цієї адреси більше немає -> часткове відновлення торкнулося цієї адреси!
          if (!silent) {
            const ok = await sendMessage(
              env,
              chatId,
              formatAlarmRestored({
                address: { street: inc.streetDisplay, house: inc.houseDisplay },
                replyPostId: replacement.postId,
              }),
            );
            if (ok) notificationsSent += 1;
          }
        } else {
          // Адреса залишилась у новому файлі — перевіряємо, чи змінився час відновлення
          const timeChanged =
            matchingRow.endDate.trim() !== inc.endDate.trim() ||
            matchingRow.endTime.trim() !== inc.endTime.trim();

          if (timeChanged && !silent) {
            const ok = await sendMessage(
              env,
              chatId,
              formatAlarmTimeChanged({
                address: trackedAddr,
                startDate: matchingRow.startDate,
                startTime: matchingRow.startTime,
                prevEndDate: inc.endDate,
                prevEndTime: inc.endTime,
                newEndDate: matchingRow.endDate,
                newEndTime: matchingRow.endTime,
                postId: replacement.postId,
              }),
            );
            if (ok) notificationsSent += 1;
          }

          const newKey = `${inc.addressId}::${replacement.postId}`;
          const nextRelated = [...new Set([...allRelatedIds, replacement.postId])];
          nextIncidents[newKey] = {
            ...inc,
            postId: replacement.postId,
            relatedPostIds: nextRelated,
            fileName: replacement.fileName,
            isPreAnnouncement: replacement.isPreAnnouncement,
            startDate: matchingRow.startDate,
            startTime: matchingRow.startTime,
            endDate: matchingRow.endDate,
            endTime: matchingRow.endTime,
            updatedAt: now,
          };
        }
        continue;
      }

      // C) Застарілий інцидент або пост прибрано з активних
      if (
        isIncidentExpired(inc.endDate, inc.endTime, now) ||
        meta.activePosts[inc.postId] === undefined
      ) {
        delete nextIncidents[incKey];
        stateChanged = true;
      }
    }

    // Крок 2: шукаємо нові відключення або зміни часу в активних постах
    const sortedPosts = Object.values(meta.activePosts).sort(
      (a, b) => Number(a.postId) - Number(b.postId),
    );

    for (const post of sortedPosts) {
      if (resolvedSet.has(post.postId)) continue;

      for (const addr of addresses) {
        const matchingRow = post.rows.find((row) => matchAddressRow(addr, row));
        if (matchingRow === undefined) continue;
        if (isIncidentExpired(matchingRow.endDate, matchingRow.endTime, now)) continue;

        const exactKey = `${addr.id}::${post.postId}`;
        if (nextIncidents[exactKey] !== undefined) continue;

        // Перевіряємо, чи вже є активний інцидент для цієї самої адреси (напр. кумулятивний файл ЗМЕМ_ЦР_8 -> 9 -> 10 або старт після вечірнього анонсу)
        const existingForAddr = Object.entries(nextIncidents).find(
          ([, v]) =>
            v.addressId === addr.id &&
            (v.fileName === post.fileName ||
              v.startDate.trim() === matchingRow.startDate.trim()),
        );

        if (existingForAddr !== undefined) {
          const [oldKey, prevInc] = existingForAddr;
          const timeChanged =
            prevInc.endDate.trim() !== matchingRow.endDate.trim() ||
            prevInc.endTime.trim() !== matchingRow.endTime.trim();

          if (timeChanged && !shouldSilenceNew) {
            const ok = await sendMessage(
              env,
              chatId,
              formatAlarmTimeChanged({
                address: addr,
                startDate: matchingRow.startDate,
                startTime: matchingRow.startTime,
                prevEndDate: prevInc.endDate,
                prevEndTime: prevInc.endTime,
                newEndDate: matchingRow.endDate,
                newEndTime: matchingRow.endTime,
                postId: post.postId,
              }),
            );
            if (ok) notificationsSent += 1;
          }

          delete nextIncidents[oldKey];
          const nextRelated = [
            ...new Set([prevInc.postId, ...(prevInc.relatedPostIds ?? []), post.postId]),
          ];
          nextIncidents[exactKey] = {
            ...prevInc,
            postId: post.postId,
            relatedPostIds: nextRelated,
            fileName: post.fileName,
            isPreAnnouncement: post.isPreAnnouncement,
            startDate: matchingRow.startDate,
            startTime: matchingRow.startTime,
            endDate: matchingRow.endDate,
            endTime: matchingRow.endTime,
            updatedAt: now,
          };
          stateChanged = true;
          continue;
        }

        // Новий інцидент для цієї адреси
        if (!shouldSilenceNew) {
          const ok = await sendMessage(
            env,
            chatId,
            formatAlarmNew({
              address: addr,
              row: matchingRow,
              postId: post.postId,
              isPreAnnouncement: post.isPreAnnouncement,
            }),
          );
          if (ok) notificationsSent += 1;
        }

        nextIncidents[exactKey] = {
          postId: post.postId,
          relatedPostIds: [post.postId],
          fileName: post.fileName,
          addressId: addr.id,
          streetDisplay: addr.street,
          houseDisplay: addr.house,
          tableStreet: matchingRow.street,
          reason: matchingRow.reason,
          isPreAnnouncement: post.isPreAnnouncement,
          startDate: matchingRow.startDate,
          startTime: matchingRow.startTime,
          endDate: matchingRow.endDate,
          endTime: matchingRow.endTime,
          notifiedAt: now,
          updatedAt: now,
        };
        stateChanged = true;
      }
    }

    if (stateChanged) {
      await putAlarmChatState(env, chatId, {
        updatedAt: now,
        incidents: nextIncidents,
        resolvedPostIds: [...resolvedSet].slice(-100),
      });
    }
  }

  return {
    ok: true,
    newPostsCount: newPosts.length,
    restoredRepliesCount: restoredReplies.length,
    activePostsCount: Object.keys(meta.activePosts).length,
    notificationsSent,
  };
}

/**
 * Знаходить усі поточні активні відключення для набору адрес за даними meta.activePosts
 * та синхронізує alarm:chat:{chatId}.
 */
export async function evaluateAddressesStatus(
  env: Env,
  chatId: number,
  addresses: readonly TrackedAddress[],
  meta: AlarmMeta,
): Promise<AddressStatusEntry[]> {
  const now = Date.now();
  if (addresses.length === 0) {
    await putAlarmChatState(env, chatId, { updatedAt: now, incidents: {} });
    return [];
  }
  const chatState = await getAlarmChatState(env, chatId);
  const resolvedSet = new Set<string>(chatState.resolvedPostIds ?? []);
  const nextIncidents: Record<string, ActiveChatIncident> = {};

  const sortedPosts = Object.values(meta.activePosts).sort(
    (a, b) => Number(a.postId) - Number(b.postId),
  );

  const entries: AddressStatusEntry[] = [];

  for (const addr of addresses) {
    const addrIncidents = new Map<string, ActiveChatIncident>();

    for (const post of sortedPosts) {
      if (resolvedSet.has(post.postId)) continue;
      const matchingRow = post.rows.find((row) => matchAddressRow(addr, row));
      if (matchingRow === undefined) continue;
      if (isIncidentExpired(matchingRow.endDate, matchingRow.endTime, now)) continue;

      // Групуємо кумулятивні пости за датою старту, залишаючи найсвіжіший postId
      const dedupKey = matchingRow.startDate.trim();
      const exactKey = `${addr.id}::${post.postId}`;
      const prev = chatState.incidents[exactKey];
      const prevGroup = addrIncidents.get(dedupKey);
      const related = [
        ...new Set([
          ...(prevGroup?.relatedPostIds ?? []),
          ...(prev?.relatedPostIds ?? []),
          post.postId,
        ]),
      ];

      const incident: ActiveChatIncident = {
        postId: post.postId,
        relatedPostIds: related,
        fileName: post.fileName,
        addressId: addr.id,
        streetDisplay: addr.street,
        houseDisplay: addr.house,
        tableStreet: matchingRow.street,
        reason: matchingRow.reason,
        isPreAnnouncement: post.isPreAnnouncement,
        startDate: matchingRow.startDate,
        startTime: matchingRow.startTime,
        endDate: matchingRow.endDate,
        endTime: matchingRow.endTime,
        notifiedAt: prevGroup?.notifiedAt ?? prev?.notifiedAt ?? now,
        updatedAt: now,
      };
      addrIncidents.set(dedupKey, incident);
    }

    const list = [...addrIncidents.values()];
    for (const inc of list) {
      nextIncidents[`${addr.id}::${inc.postId}`] = inc;
    }
    entries.push({ address: addr, incidents: list });
  }

  await putAlarmChatState(env, chatId, {
    updatedAt: now,
    incidents: nextIncidents,
    resolvedPostIds: [...resolvedSet].slice(-100),
  });
  return entries;
}

/** Перевірка прав адміністратора (та сама логіка ADMIN_IDS, що і для черг). */
function isAddressAdmin(env: Env, userId: number | undefined): boolean {
  const raw: string = env.ADMIN_IDS ?? "";
  const ids = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id !== 0);
  if (ids.length === 0) return true;
  return userId !== undefined && ids.includes(userId);
}

/**
 * Обробляє команду `/address`:
 *   `/address` — список адрес і поточний статус
 *   `/address add <вулиця> <будинок>` — додати адресу
 *   `/address remove <номер у списку або адреса>` — видалити адресу
 */
export async function handleAddressCommand(
  env: Env,
  chatId: number,
  argument: string,
  userId: number | undefined,
): Promise<void> {
  const trimmed = argument.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "status" || trimmed.toLowerCase() === "list") {
    await showAddressMenu(env, chatId);
    return;
  }

  if (!isAddressAdmin(env, userId)) {
    await sendMessage(env, chatId, formatQueueForbidden());
    return;
  }

  const spaceIdx = trimmed.search(/\s/);
  const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  if (verb === "add" || verb === "+") {
    await handleAddressAdd(env, chatId, rest);
    return;
  }

  if (verb === "remove" || verb === "rm" || verb === "del" || verb === "-") {
    await handleAddressRemove(env, chatId, rest);
    return;
  }

  // Якщо користувач написав `/address Мирослава Симчича 21А` без слова `add` — теж додаємо
  await handleAddressAdd(env, chatId, trimmed);
}

async function handleAddressAdd(env: Env, chatId: number, rawAddress: string): Promise<void> {
  const parsed = parseAddressInput(rawAddress);
  if (parsed === null) {
    await sendMessage(env, chatId, formatAddressInvalid());
    return;
  }

  const current = await getChatAddresses(env, chatId);
  if (current.some((a) => a.id === parsed.id)) {
    await sendMessage(env, chatId, formatAddressAlreadyTracked(parsed));
    return;
  }

  if (current.length >= MAX_ADDRESSES_PER_CHAT) {
    await sendMessage(env, chatId, formatAddressLimit(MAX_ADDRESSES_PER_CHAT));
    return;
  }

  const next = [...current, parsed];
  await setChatAddresses(env, chatId, next);
  await sendMessage(env, chatId, formatAddressAdded(parsed));
  await showAddressMenu(env, chatId);
}

async function handleAddressRemove(env: Env, chatId: number, targetRaw: string): Promise<void> {
  if (!targetRaw) {
    await showAddressMenu(env, chatId);
    return;
  }

  const current = await getChatAddresses(env, chatId);
  if (current.length === 0) {
    await showAddressMenu(env, chatId);
    return;
  }

  let removed: TrackedAddress | undefined;
  // 1. За порядковим номером (1..N)
  if (/^\d+$/.test(targetRaw)) {
    const idx = Number(targetRaw) - 1;
    if (idx >= 0 && idx < current.length) {
      removed = current[idx];
    }
  }

  // 2. За розпізнаною адресою
  if (removed === undefined) {
    const parsed = parseAddressInput(targetRaw);
    if (parsed !== null) {
      removed = current.find((a) => a.id === parsed.id);
    }
  }

  // 3. За входженням підрядка вулиці/будинку
  if (removed === undefined) {
    const lower = targetRaw.toLowerCase();
    removed = current.find(
      (a) => `${a.street} ${a.house}`.toLowerCase().includes(lower),
    );
  }

  if (removed === undefined) {
    await sendMessage(env, chatId, formatAddressNotFound(targetRaw));
    return;
  }

  const next = current.filter((a) => a.id !== removed.id);
  await setChatAddresses(env, chatId, next);
  await sendMessage(env, chatId, formatAddressRemoved(removed));
  await showAddressMenu(env, chatId);
}

async function showAddressMenu(env: Env, chatId: number): Promise<void> {
  const addresses = await getChatAddresses(env, chatId);
  const meta = await getAlarmMeta(env);
  const entries = await evaluateAddressesStatus(env, chatId, addresses, meta);
  await sendMessage(
    env,
    chatId,
    formatAddressMenu({ entries, lastCheckAt: meta.lastCheckAt }),
    addressListKeyboard(addresses),
  );
}

/**
 * Обробляє натискання інлайн-кнопки видалення адреси (`ad:<hash>`).
 */
export async function handleAddressDeleteCallback(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const chatId = callbackQuery.message?.chat.id;
  const data = callbackQuery.data ?? "";
  if (chatId === undefined || !data.startsWith("ad:")) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  if (!isAddressAdmin(env, callbackQuery.from?.id)) {
    await answerCallbackQuery(env, callbackQuery.id, "⛔️ Адреси змінює лише адміністратор");
    return;
  }

  const hash = data.slice("ad:".length);
  const current = await getChatAddresses(env, chatId);
  const target = current.find((a) => addressHash(a.id) === hash);

  if (target === undefined) {
    await answerCallbackQuery(env, callbackQuery.id, "Адресу вже видалено");
    return;
  }

  const next = current.filter((a) => a.id !== target.id);
  await setChatAddresses(env, chatId, next);
  const meta = await getAlarmMeta(env);
  const entries = await evaluateAddressesStatus(env, chatId, next, meta);
  const text = formatAddressMenu({ entries, lastCheckAt: meta.lastCheckAt });
  const keyboard = addressListKeyboard(next);

  const messageId = callbackQuery.message?.message_id;
  if (messageId !== undefined) {
    await editMessageText(env, chatId, messageId, text, keyboard);
  } else {
    await sendMessage(env, chatId, text, keyboard);
  }

  await answerCallbackQuery(
    env,
    callbackQuery.id,
    `🗑 Видалено: ${target.street}, ${target.house}`,
  );
}
