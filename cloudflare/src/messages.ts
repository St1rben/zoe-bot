/** Тексти повідомлень (HTML). Базуються на Python-версії, розширені для наборів черг. */

import {
  OUTAGE_URL,
  SCENARIO_ABSENT,
  SCENARIO_NO_SCHEDULE,
  SCENARIO_PRESENT,
  sortQueues,
  type Scenario,
} from "./parser";
import type { QueueScenario } from "./state";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./telegram";

export const COMMANDS_HELP =
  "/status — поточний стан\n" +
  "/queue — обрати черги (кнопки)\n" +
  "/queue add 3.1 6.2 — додати черги\n" +
  "/queue remove 5.1 — прибрати черги\n" +
  "/help — ця довідка";

const SOURCE_LINE = `<a href="${OUTAGE_URL}">Джерело: zoe.com.ua</a>`;

/** Одна пара «черга → її сценарій» для зведених повідомлень. */
export type QueueScenarioEntry = readonly [string, Scenario];

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function humanizeSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total} с`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} хв`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return `${hours} год ${restMinutes} хв`;
  const days = Math.floor(hours / 24);
  return `${days} д ${hours % 24} год`;
}

export function formatStartup(queues: readonly string[]): string {
  const label = queues.length === 1 ? "черги" : "черг";
  const list = escapeHtml(queues.join(", "));
  return `🟢 <b>Бот запущено!</b>\n\nМоніторинг ${label} <b>${list}</b> активний.`;
}

export function formatWelcome(queues: readonly string[]): string {
  return (
    "👋 <b>ZOE Outage Bot</b>\n\n" +
    "Слідкую за графіками погодинних відключень на zoe.com.ua " +
    "і пишу сюди, коли вони з'являються або змінюються.\n\n" +
    `Ваші черги: <b>${escapeHtml(queues.join(", "))}</b>\n\n` +
    COMMANDS_HELP
  );
}

export function formatHelp(): string {
  return `📖 <b>Команди</b>\n\n${COMMANDS_HELP}`;
}

/** Легаси-формат: замінити весь набір черг новим списком. */
export function formatQueuesSet(queues: readonly string[]): string {
  if (queues.length === 1) {
    return `✅ Відстежувана черга: <b>${escapeHtml(queues[0] ?? "")}</b>.`;
  }
  return `✅ Відстежувані черги: <b>${escapeHtml(queues.join(", "))}</b>.`;
}

export function formatQueueIsDefault(queue: string): string {
  return (
    `⚠️ Черга <b>${escapeHtml(queue)}</b> — за замовчуванням, поки інших черг немає.\n` +
    `Спершу додайте інші черги, потім цю можна прибрати.`
  );
}

export function formatQueueInvalid(raw: string): string {
  return (
    `⚠️ «${escapeHtml(raw)}» не схоже на номер черги.\n` +
    "Приклади: <code>/queue add 5.1 4.2</code>, <code>/queue 3</code>"
  );
}

function previousScenarioShort(prev: QueueScenario): string {
  if (prev.kind === SCENARIO_PRESENT) return escapeHtml(prev.times ?? "");
  return "без відключень";
}

function scenarioLine(queue: string, scenario: Scenario, prev?: QueueScenario): string {
  const changed = prev !== undefined && (prev.kind !== scenario.kind || prev.times !== scenario.times);
  const diffSuffix = changed ? ` (було: ${previousScenarioShort(prev)})` : "";

  if (scenario.kind === SCENARIO_NO_SCHEDULE) {
    return (
      "Графіки погодинних відключень не заплановані.\n" +
      `Черга ${escapeHtml(queue)} сьогодні не відключатиметься 🎉${diffSuffix}`
    );
  }
  if (scenario.kind === SCENARIO_PRESENT) {
    return `🔴 Черга ${escapeHtml(queue)}: ${escapeHtml(scenario.times ?? "")}${diffSuffix}`;
  }
  return `Черга ${escapeHtml(queue)} у графіку відсутня — світло не відключатимуть 🎉${diffSuffix}`;
}

function scenarioLines(
  entries: readonly QueueScenarioEntry[],
  prevQueues?: Record<string, QueueScenario>,
): string {
  return entries.map(([queue, scenario]) => scenarioLine(queue, scenario, prevQueues?.[queue])).join("\n");
}

function updateIcon(entries: readonly QueueScenarioEntry[]): string {
  if (entries.length === 0) return "⚡";
  if (entries.some(([, scenario]) => scenario.kind === SCENARIO_PRESENT)) return "⚡";
  if (entries.every(([, scenario]) => scenario.kind === SCENARIO_ABSENT)) return "✅";
  return "☀️";
}

export function formatMultiUpdate(
  title: string,
  entries: readonly QueueScenarioEntry[],
  prevQueues?: Record<string, QueueScenario>,
): string {
  return (
    `${updateIcon(entries)} <b>${escapeHtml(title)}</b>\n\n` +
    `${scenarioLines(entries, prevQueues)}\n\n` +
    SOURCE_LINE
  );
}

export function formatMultiUnchangedUpdate(
  title: string,
  entries: readonly QueueScenarioEntry[],
): string {
  return (
    `🔄 <b>${escapeHtml(title)}</b>\n\n` +
    "Графіки було оновлено, але для ваших черг усе без змін 👌\n\n" +
    `${scenarioLines(entries)}\n\n` +
    SOURCE_LINE
  );
}

export function formatMultiDigest(title: string, entries: readonly QueueScenarioEntry[]): string {
  return (
    "🌙 <b>Нагадування про графік</b>\n\n" +
    `${escapeHtml(title)}\n` +
    scenarioLines(entries)
  );
}

/**
 * Повідомлення вибору черг: поточний набір + сценарії (якщо дані відомі) + легенда.
 * Клавіатуру будує queuePickerKeyboard.
 */
export function formatQueuesMessage(options: {
  queues: readonly string[];
  isDefault: boolean;
  entries: readonly QueueScenarioEntry[] | null;
}): string {
  const lines = ["⚙️ <b>Черги цього чату</b>", ""];
  lines.push(
    options.isDefault
      ? `Зараз — черга за замовчуванням: <b>${escapeHtml(options.queues.join(", "))}</b>`
      : `Відстежуються: <b>${escapeHtml(options.queues.join(", "))}</b>`,
  );
  if (options.entries !== null) {
    lines.push("", scenarioLines(options.entries));
  }
  lines.push(
    "",
    "Тапніть кнопку, щоб додати або прибрати чергу (✅ — відстежується).",
    "Команди: <code>/queue add 3.1 6.2</code> · <code>/queue remove 5.1</code>",
  );
  return lines.join("\n");
}

/**
 * Інлайн-клавіатура вибору черг: усі відомі черги по 3 в ряду,
 * відстежувані — з ✅, тап перемикає (callback_data «qt:N.N»).
 */
export function queuePickerKeyboard(
  tracked: readonly string[],
  known: readonly string[],
): InlineKeyboardMarkup {
  const trackedSet = new Set(tracked);
  const grid = sortQueues([...tracked, ...known]);
  const columns = 3;
  const rows: InlineKeyboardButton[][] = [];
  for (let index = 0; index < grid.length; index += columns) {
    rows.push(
      grid.slice(index, index + columns).map((queue) => ({
        text: trackedSet.has(queue) ? `✅ ${queue}` : queue,
        callback_data: `qt:${queue}`,
      })),
    );
  }
  return { inline_keyboard: rows };
}

export function formatQueuesAdded(added: readonly string[]): string {
  const label = added.length === 1 ? "чергу" : "черги";
  return `✅ Додано ${label}: <b>${escapeHtml(added.join(", "))}</b>.`;
}

export function formatQueuesRemoved(removed: readonly string[]): string {
  const label = removed.length === 1 ? "чергу" : "черги";
  return `🗑 Прибрано ${label}: <b>${escapeHtml(removed.join(", "))}</b>.`;
}

export function formatQueuesAlreadyTracked(queues: readonly string[]): string {
  return `⚠️ Ці черги вже відстежуються: <b>${escapeHtml(queues.join(", "))}</b>.`;
}

export function formatQueuesNotTracked(queues: readonly string[]): string {
  return `⚠️ Ці черги не відстежуються — прибирати нічого: <b>${escapeHtml(queues.join(", "))}</b>.`;
}

export function formatQueuesResetToDefault(defaultQueue: string): string {
  return `Тепер відстежується черга за замовчуванням: <b>${escapeHtml(defaultQueue)}</b>.`;
}

export function formatQueueLimit(limit: number): string {
  return `⚠️ Максимум ${limit} черг на чат. Спершу приберіть зайві: <code>/queue remove …</code>`;
}

export function formatQueueForbidden(): string {
  return "⛔️ Змінювати черги може лише адміністратор бота.";
}

/** Службовий алерт адміну: сторінка/пости не схожі на графік кілька перевірок підряд. */
export function formatParseAlert(postsCount: number, streak: number): string {
  const detail =
    postsCount === 0
      ? "Сторінка не містила жодної статті або не розпарсилась"
      : `Знайдено статей: ${postsCount}, але жодна не схожа на графік для населення`;
  return (
    "⚠️ <b>Проблема з розбором графіків</b>\n\n" +
    `${detail}.\n` +
    `Серія: <b>${streak}</b> перевірок підряд (~${humanizeSeconds(streak * 300)}). ` +
    "Можливо, zoe.com.ua змінив формат публікації.\n\n" +
    "Сповіщення про відключення можуть затримуватися, доки формат не відновиться."
  );
}

export function formatStatus(options: {
  queues: readonly string[];
  entries: readonly QueueScenarioEntry[] | null;
  updatedAt: number | null;
  /** Попередження, якщо найсвіжіший пост не за сьогодні (див. stalePostNote). */
  staleNote?: string | null;
  /** Час останньої успішної перевірки сайту (meta.lastIngestAt) — доказ, що моніторинг живий. */
  checkedAt?: number | null;
}): string {
  const lines = [
    "📊 <b>Статус бота</b>",
    "",
    `Черги: <b>${escapeHtml(options.queues.join(", "))}</b>`,
  ];
  if (options.staleNote) lines.push(options.staleNote);
  if (options.entries === null) {
    lines.push("Стан черг: ⏳ даних ще немає");
  } else {
    lines.push(scenarioLines(options.entries));
  }
  if (options.updatedAt !== null) {
    const age = (Date.now() - options.updatedAt) / 1000;
    lines.push(`Оновлено: ${humanizeSeconds(age)} тому`);
  }
  if (options.checkedAt !== null && options.checkedAt !== undefined) {
    const checkedAge = (Date.now() - options.checkedAt) / 1000;
    lines.push(`Перевірено: ${humanizeSeconds(checkedAge)} тому`);
  }
  return lines.join("\n");
}
