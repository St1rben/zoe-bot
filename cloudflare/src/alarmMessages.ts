/**
 * Форматування повідомлень та інлайн-клавіатур для адресних відключень (@zoe_alarm).
 * Виконано в єдиній стилістиці з основними повідомленнями ГПВ (messages.ts).
 */

import { DEFAULT_SETTLEMENT, type AlarmRow, type TrackedAddress } from "./address";
import type { ActiveChatIncident } from "./alarmState";
import { escapeHtml, humanizeSeconds } from "./messages";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./telegram";

export const ALARM_CHANNEL_URL = "https://t.me/zoe_alarm";

/** Короткий детермінований FNV-1a хеш адреси (8 hex-символів) для callback_data (ліміт Telegram — 64 байти). */
export function addressHash(addressId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < addressId.length; i += 1) {
    hash ^= addressId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeTimeDisplay(raw: string): string {
  const m = /^(\d{1,2})[-:](\d{2})$/.exec(raw.trim());
  if (m === null) return raw.trim();
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

function shortDateDisplay(raw: string): string {
  const m = /^(\d{2}\.\d{2})\.\d{4}$/.exec(raw.trim());
  return m !== null ? m[1]! : raw.trim();
}

function formatTimeWindow(
  startDate: string,
  startTime: string,
  endDate: string,
  endTime: string,
): string {
  const st = normalizeTimeDisplay(startTime);
  const et = normalizeTimeDisplay(endTime);
  const sd = startDate.trim();
  const ed = endDate.trim();

  if (sd && ed && sd !== ed) {
    return `з ${st} (${shortDateDisplay(sd)}) до ${et} (${shortDateDisplay(ed)})`;
  }
  if (sd) {
    return `з ${st} до ${et} (${shortDateDisplay(sd)})`;
  }
  return `з ${st} до ${et}`;
}

function isEmergencyReason(reason: string): boolean {
  return reason.toLowerCase().includes("авар");
}

function sourceLine(postId?: string): string {
  const url = postId
    ? `${ALARM_CHANNEL_URL}/${encodeURIComponent(postId)}`
    : ALARM_CHANNEL_URL;
  return `<a href="${url}">Джерело: @zoe_alarm</a>`;
}

/** Клавіатура зі списком адрес чату та кнопками швидкого видалення. */
export function addressListKeyboard(
  addresses: readonly TrackedAddress[],
): InlineKeyboardMarkup | undefined {
  if (addresses.length === 0) return undefined;
  const rows: InlineKeyboardButton[][] = addresses.map((addr) => [
    {
      text: `🗑 ${addr.street}, ${addr.house}`,
      callback_data: `ad:${addressHash(addr.id)}`,
    },
  ]);
  return { inline_keyboard: rows };
}

export interface AddressStatusEntry {
  address: TrackedAddress;
  incidents: ActiveChatIncident[];
}

function incidentStatusLine(address: TrackedAddress, inc: ActiveChatIncident): string {
  const addrLabel = `${escapeHtml(address.street)}, ${escapeHtml(address.house)}`;
  const windowStr = escapeHtml(
    formatTimeWindow(inc.startDate, inc.startTime, inc.endDate, inc.endTime),
  );
  const tag = inc.isPreAnnouncement
    ? "заплановано"
    : isEmergencyReason(inc.reason)
      ? "аварійне"
      : "планове";
  return `🔴 ${addrLabel}: ${windowStr} — ${tag}`;
}

export function formatAddressMenu(options: {
  entries: readonly AddressStatusEntry[];
  lastCheckAt: number | null;
}): string {
  const lines: string[] = ["⚙️ <b>Адреси цього чату</b>", ""];

  if (options.entries.length === 0) {
    lines.push(
      "Наразі жодної адреси не додано.",
      "",
      "Команди: <code>/address add Вулиця Будинок</code> · <code>/address remove 1</code>",
    );
    if (options.lastCheckAt !== null) {
      const age = (Date.now() - options.lastCheckAt) / 1000;
      lines.push(`Перевірено: ${humanizeSeconds(age)} тому`);
    }
    return lines.join("\n");
  }

  const trackedList = options.entries
    .map(({ address }) => `${escapeHtml(address.street)}, ${escapeHtml(address.house)}`)
    .join("; ");
  lines.push(`Відстежуються: <b>${trackedList}</b>`, "");

  for (const { address, incidents } of options.entries) {
    const addrLabel = `${escapeHtml(address.street)}, ${escapeHtml(address.house)}`;
    if (incidents.length === 0) {
      lines.push(`${addrLabel} — активних відключень немає 🎉`);
    } else {
      for (const inc of incidents) {
        lines.push(incidentStatusLine(address, inc));
      }
    }
  }

  lines.push(
    "",
    "Тапніть кнопку нижче, щоб прибрати адресу зі списку.",
    "Команди: <code>/address add Вулиця Будинок</code> · <code>/address remove 1</code>",
  );

  if (options.lastCheckAt !== null) {
    const age = (Date.now() - options.lastCheckAt) / 1000;
    lines.push(`Перевірено: ${humanizeSeconds(age)} тому`);
  }

  return lines.join("\n");
}

export function formatAddressAdded(address: TrackedAddress): string {
  return (
    `✅ Додано адресу: <b>${DEFAULT_SETTLEMENT}, ${escapeHtml(address.street)}, ${escapeHtml(address.house)}</b>.`
  );
}

export function formatAddressAlreadyTracked(address: TrackedAddress): string {
  return (
    `⚠️ Ця адреса вже відстежується: <b>${escapeHtml(address.street)}, ${escapeHtml(address.house)}</b>.`
  );
}

export function formatAddressRemoved(address: TrackedAddress): string {
  return `🗑 Прибрано адресу: <b>${escapeHtml(address.street)}, ${escapeHtml(address.house)}</b>.`;
}

export function formatAddressNotFound(raw: string): string {
  return `⚠️ Адресу «${escapeHtml(raw)}» не знайдено у списку цього чату.`;
}

export function formatAddressInvalid(): string {
  return (
    "⚠️ Не вдалося розпізнати адресу. Вкажіть вулицю та номер будинку.\n" +
    "Приклади: <code>/address add Мирослава Симчича 21А</code>, <code>/address add Вогняний 5</code>"
  );
}

export function formatAddressLimit(limit: number): string {
  return `⚠️ Максимум ${limit} адрес на чат. Спершу приберіть зайві: <code>/address remove …</code>`;
}

/** Повідомлення про нове аварійне або планове відключення за адресою (у стилі ГПВ). */
export function formatAlarmNew(options: {
  address: TrackedAddress;
  row: AlarmRow;
  postId: string;
  isPreAnnouncement: boolean;
}): string {
  const emergency = isEmergencyReason(options.row.reason);
  const dateLabel = shortDateDisplay(options.row.startDate);
  const title = options.isPreAnnouncement
    ? `ЗАПЛАНОВАНО РЕМОНТНІ РОБОТИ${dateLabel ? ` НА ${dateLabel}` : ""}`
    : emergency
      ? "АВАРІЙНЕ ВІДКЛЮЧЕННЯ ЗА АДРЕСОЮ"
      : "ПЛАНОВЕ ВІДКЛЮЧЕННЯ ЗА АДРЕСОЮ";

  const addrLabel = `${escapeHtml(options.address.street)}, ${escapeHtml(options.address.house)}`;
  const windowStr = escapeHtml(
    formatTimeWindow(
      options.row.startDate,
      options.row.startTime,
      options.row.endDate,
      options.row.endTime,
    ),
  );

  return (
    `⚡ <b>${escapeHtml(title)}</b>\n\n` +
    `🔴 ${addrLabel}: ${windowStr}\n\n` +
    sourceLine(options.postId)
  );
}

/** Повідомлення про зміну орієнтовного часу відновлення (у стилі ГПВ з позначкою «було: …»). */
export function formatAlarmTimeChanged(options: {
  address: TrackedAddress;
  startDate?: string;
  startTime?: string;
  prevEndDate: string;
  prevEndTime: string;
  newEndDate: string;
  newEndTime: string;
  postId: string;
}): string {
  const addrLabel = `${escapeHtml(options.address.street)}, ${escapeHtml(options.address.house)}`;
  const sameEndDate = options.prevEndDate.trim() === options.newEndDate.trim();
  const prevShort = sameEndDate
    ? `до ${normalizeTimeDisplay(options.prevEndTime)}`
    : `до ${normalizeTimeDisplay(options.prevEndTime)} (${shortDateDisplay(options.prevEndDate)})`;

  const currentWindow = options.startTime
    ? formatTimeWindow(
        options.startDate ?? options.newEndDate,
        options.startTime,
        options.newEndDate,
        options.newEndTime,
      )
    : `до ${normalizeTimeDisplay(options.newEndTime)} (${shortDateDisplay(options.newEndDate)})`;

  return (
    "⚡ <b>ОНОВЛЕНО ЧАС ВІДКЛЮЧЕННЯ ЗА АДРЕСОЮ</b>\n\n" +
    `🔴 ${addrLabel}: ${escapeHtml(currentWindow)} (було: ${escapeHtml(prevShort)})\n\n` +
    sourceLine(options.postId)
  );
}

/** Повідомлення про відновлення електропостачання за адресою (у стилі ГПВ). */
export function formatAlarmRestored(options: {
  address: { street: string; house: string };
  replyPostId?: string;
}): string {
  const addrLabel = `${escapeHtml(options.address.street)}, ${escapeHtml(options.address.house)}`;
  return (
    "✅ <b>ЕЛЕКТРОПОСТАЧАННЯ ВІДНОВЛЕНО</b>\n\n" +
    `${addrLabel} — електропостачання відновлено 🎉\n\n` +
    sourceLine(options.replyPostId)
  );
}
