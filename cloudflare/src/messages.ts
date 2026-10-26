/** Тексти повідомлень (HTML), один в один з Python-версією. */

import {
  OUTAGE_URL,
  SCENARIO_ABSENT,
  SCENARIO_NO_SCHEDULE,
  SCENARIO_PRESENT,
  type Scenario,
} from "./parser";

export const COMMANDS_HELP =
  "/status — поточний стан\n/queue 5.1 — змінити чергу для цього чату\n/help — ця довідка";

const SOURCE_LINE = `<a href="${OUTAGE_URL}">Джерело: zoe.com.ua</a>`;

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

export function formatStartup(queue: string): string {
  return `🟢 <b>Бот запущено!</b>\n\nМоніторинг черги <b>${escapeHtml(queue)}</b> активний.`;
}

export function formatWelcome(queue: string): string {
  return (
    "👋 <b>ZOE Outage Bot</b>\n\n" +
    "Слідкую за графіками погодинних відключень на zoe.com.ua " +
    "і пишу сюди, коли вони з'являються або змінюються.\n\n" +
    `Ваша черга: <b>${escapeHtml(queue)}</b>\n\n` +
    COMMANDS_HELP
  );
}

export function formatHelp(): string {
  return `📖 <b>Команди</b>\n\n${COMMANDS_HELP}`;
}

export function formatQueueCurrent(queue: string, isDefault: boolean): string {
  const source = isDefault ? "значення за замовчуванням" : "обрано для цього чату";
  return (
    `⚙️ Поточна черга: <b>${escapeHtml(queue)}</b> (${source}).\n\n` +
    "Змінити: <code>/queue 4.2</code>"
  );
}

export function formatQueueSet(queue: string): string {
  return `✅ Чергу змінено на <b>${escapeHtml(queue)}</b>. Наступні оновлення — для неї.`;
}

export function formatQueueInvalid(raw: string): string {
  return (
    `⚠️ «${escapeHtml(raw)}» не схоже на номер черги.\n` +
    "Приклади: <code>/queue 5.1</code>, <code>/queue 3</code>"
  );
}

function scenarioLine(queue: string, scenario: Scenario): string {
  if (scenario.kind === SCENARIO_NO_SCHEDULE) {
    return (
      "Графіки погодинних відключень не заплановані.\n" +
      `Черга ${escapeHtml(queue)} сьогодні не відключатиметься 🎉`
    );
  }
  if (scenario.kind === SCENARIO_PRESENT) {
    return `🔴 Черга ${escapeHtml(queue)}: ${escapeHtml(scenario.times ?? "")}`;
  }
  return `Черга ${escapeHtml(queue)} у графіку відсутня — світло не відключатимуть 🎉`;
}

export function formatUpdate(title: string, queue: string, scenario: Scenario): string {
  const icon =
    scenario.kind === SCENARIO_NO_SCHEDULE
      ? "☀️"
      : scenario.kind === SCENARIO_PRESENT
        ? "⚡"
        : "✅";
  return (
    `${icon} <b>${escapeHtml(title)}</b>\n\n` +
    `${scenarioLine(queue, scenario)}\n\n` +
    SOURCE_LINE
  );
}

export function formatUnchangedUpdate(title: string, queue: string, scenario: Scenario): string {
  return (
    `🔄 <b>${escapeHtml(title)}</b>\n\n` +
    `Графіки було оновлено, але для нашої черги все так само без змін 👌\n\n` +
    `${scenarioLine(queue, scenario)}\n\n` +
    SOURCE_LINE
  );
}

export function formatDigest(title: string, queue: string, scenario: Scenario): string {
  return (
    "🌙 <b>Нагадування про графік</b>\n\n" + `${escapeHtml(title)}\n` + scenarioLine(queue, scenario)
  );
}

export function formatStatus(options: {
  queue: string;
  title: string | null;
  scenario: Scenario | null;
  updatedAt: number | null;
  /** Попередження, якщо найсвіжіший пост не за сьогодні (див. stalePostNote). */
  staleNote?: string | null;
  /** Час останньої успішної перевірки сайту (meta.lastIngestAt) — доказ, що моніторинг живий. */
  checkedAt?: number | null;
}): string {
  const lines = ["📊 <b>Статус бота</b>", "", `Черга: <b>${escapeHtml(options.queue)}</b>`];
  if (options.staleNote) lines.push(options.staleNote);
  if (options.title) lines.push(`Останній пост: ${escapeHtml(options.title)}`);
  if (options.scenario === null) {
    lines.push("Стан черги: ⏳ даних ще немає");
  } else {
    lines.push(`Стан черги: ${scenarioLine(options.queue, options.scenario)}`);
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
