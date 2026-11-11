/**
 * Форматування повідомлень та інлайн-клавіатур для адресних відключень (@zoe_alarm).
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
  return raw.trim().replace(/^(\d{1,2})-(\d{2})$/, "$1:$2");
}

function formatDateTime(date: string, time: string): string {
  const d = date.trim();
  const t = normalizeTimeDisplay(time);
  if (d && t) return `${d} о ${t}`;
  return d || t || "невідомо";
}

function isEmergencyReason(reason: string): boolean {
  return reason.toLowerCase().includes("авар");
}

function postLink(postId: string, label?: string): string {
  const text = label ? escapeHtml(label) : `пост #${escapeHtml(postId)}`;
  return `<a href="${ALARM_CHANNEL_URL}/${ encodeURIComponent(postId)}">${text}</a>`;
}

/** Клавіатура зі списком адрес чату та кнопками швидкого видалення. */
export function addressListKeyboard(addresses: readonly TrackedAddress[]): InlineKeyboardMarkup | undefined {
  if (addresses.length === 0) return undefined;
  const rows: InlineKeyboardButton[][] = addresses.map((addr) => [
    {
      text: `🗑 Видалити: ${addr.street}, ${addr.house}`,
      callback_data: `ad:${addressHash(addr.id)}`,
    },
  ]);
  return { inline_keyboard: rows };
}

export interface AddressStatusEntry {
  address: TrackedAddress;
  incidents: ActiveChatIncident[];
}

export function formatAddressMenu(options: {
  entries: readonly AddressStatusEntry[];
  lastCheckAt: number | null;
}): string {
  const lines: string[] = ["🏠 <b>Адреси цього чату (м. Запоріжжя)</b>", ""];

  if (options.entries.length === 0) {
    lines.push(
      "Наразі жодної адреси не додано.",
      "",
      "Щоб відстежувати планові та аварійні відключення з <code>@zoe_alarm</code>, додайте адресу:",
      "<code>/address add Мирослава Симчича 21А</code>",
      "<code>/address add пров. Вогняний 5</code>",
    );
    return lines.join("\n");
  }

  for (const { address, incidents } of options.entries) {
    const label = `📍 <b>${escapeHtml(address.street)}, ${escapeHtml(address.house)}</b>`;
    if (incidents.length === 0) {
      lines.push(`${label}\n   🟢 Активних відключень немає`);
    } else {
      for (const inc of incidents) {
        const icon = inc.isPreAnnouncement
          ? "🗓"
          : isEmergencyReason(inc.reason)
            ? "🚨"
            : "🛠";
        const kindText = inc.isPreAnnouncement
          ? "Заплановано ремонтні роботи"
          : isEmergencyReason(inc.reason)
            ? "Аварійне відключення"
            : "Планове відключення";
        const startStr = formatDateTime(inc.startDate, inc.startTime);
        const endStr = formatDateTime(inc.endDate, inc.endTime);
        lines.push(
          `${label}\n` +
            `   ${icon} <b>${kindText}</b> (${postLink(inc.postId)})\n` +
            `   🕐 Початок: <code>${escapeHtml(startStr)}</code>\n` +
            `   🔄 Орієнтовне відновлення: <b><code>${escapeHtml(endStr)}</code></b>`,
        );
      }
    }
  }

  lines.push(
    "",
    "Команди: <code>/address add Вулиця Будинок</code> · <code>/address remove 1</code>",
  );

  if (options.lastCheckAt !== null) {
    const age = (Date.now() - options.lastCheckAt) / 1000;
    lines.push(`Перевірено @zoe_alarm: ${humanizeSeconds(age)} тому`);
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
    "Приклади:\n" +
    "<code>/address add Мирослава Симчича 21А</code>\n" +
    "<code>/address add пров. Вогняний 5</code>"
  );
}

export function formatAddressLimit(limit: number): string {
  return `⚠️ Максимум ${limit} адрес на чат. Спершу приберіть зайві через <code>/address</code>.`;
}

/** Повідомлення про нове аварійне або планове відключення за адресою. */
export function formatAlarmNew(options: {
  address: TrackedAddress;
  row: AlarmRow;
  postId: string;
  isPreAnnouncement: boolean;
}): string {
  const emergency = isEmergencyReason(options.row.reason);
  const header = options.isPreAnnouncement
    ? "🗓 <b>Заплановано відключення за адресою!</b>"
    : emergency
      ? "🚨 <b>Аварійне відключення за адресою!</b>"
      : "🛠 <b>Планове відключення за адресою!</b>";

  const reasonLabel = emergency ? "аварійні роботи" : "планові ремонтні роботи";
  const startStr = formatDateTime(options.row.startDate, options.row.startTime);
  const endStr = formatDateTime(options.row.endDate, options.row.endTime);

  return (
    `${header}\n\n` +
    `📍 <b>${DEFAULT_SETTLEMENT}, ${escapeHtml(options.address.street)}, ${escapeHtml(options.address.house)}</b>\n` +
    `📋 Причина: ${reasonLabel} (${postLink(options.postId)})\n` +
    `🕐 Початок: <code>${escapeHtml(startStr)}</code>\n` +
    `🔄 Орієнтовне відновлення: <b><code>${escapeHtml(endStr)}</code></b>`
  );
}

/** Повідомлення про зміну орієнтовного часу відновлення. */
export function formatAlarmTimeChanged(options: {
  address: TrackedAddress;
  prevEndDate: string;
  prevEndTime: string;
  newEndDate: string;
  newEndTime: string;
  postId: string;
}): string {
  const prevStr =
    options.prevEndDate.trim() === options.newEndDate.trim()
      ? normalizeTimeDisplay(options.prevEndTime)
      : formatDateTime(options.prevEndDate, options.prevEndTime);
  const newStr = formatDateTime(options.newEndDate, options.newEndTime);

  return (
    "⏳ <b>Змінено час відновлення за адресою!</b>\n\n" +
    `📍 <b>${DEFAULT_SETTLEMENT}, ${escapeHtml(options.address.street)}, ${escapeHtml(options.address.house)}</b>\n` +
    `🔄 Новий час відновлення: <b><code>${escapeHtml(newStr)}</code></b> (було: <code>${escapeHtml(prevStr)}</code>)\n` +
    `🔗 Джерело: ${postLink(options.postId)}`
  );
}

/** Повідомлення про відновлення електропостачання за адресою. */
export function formatAlarmRestored(options: {
  address: { street: string; house: string };
  replyPostId?: string;
}): string {
  const sourceSuffix = options.replyPostId ? `\n🔗 ${postLink(options.replyPostId, "Джерело: @zoe_alarm")}` : "";
  return (
    "🟢 <b>Електропостачання відновлено!</b>\n\n" +
    `📍 <b>${DEFAULT_SETTLEMENT}, ${escapeHtml(options.address.street)}, ${escapeHtml(options.address.house)}</b>` +
    sourceSuffix
  );
}
