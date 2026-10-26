/**
 * Парсинг сторінки zoe.com.ua/outage.
 *
 * Структура статті: <article id="post-N"> <h2>заголовок</h2> <div class="content">…</div> </article>
 * Рядки черг у тексті: «5.1: 08:00 – 10:00, 16:00 – 20:00».
 */

export const OUTAGE_URL = "https://www.zoe.com.ua/outage/";

export const SCENARIO_NO_SCHEDULE = "no_schedule";
export const SCENARIO_PRESENT = "present";
export const SCENARIO_ABSENT = "absent";

export type ScenarioKind =
  | typeof SCENARIO_NO_SCHEDULE
  | typeof SCENARIO_PRESENT
  | typeof SCENARIO_ABSENT;

export interface Scenario {
  kind: ScenarioKind;
  times: string | null;
}

export interface OutagePost {
  id: string;
  title: string;
  text: string;
  queues: Record<string, string>;
}

const NO_SCHEDULE_MARKERS = ["НЕ ЗАПЛАНОВАНІ", "НЕ ПЛАНУЮТЬСЯ"];
// Пости «до уваги промисловості та бізнесу» не стосуються населення
const BUSINESS_TITLE_MARKERS = ["ПРОМИСЛОВОСТ", "БІЗНЕС"];
const BUSINESS_TEXT_MARKERS = ["НЕ СТОСУЮТЬСЯ НАСЕЛЕННЯ"];

const QUEUE_LINE_RE = /^(\d+(?:\.\d+)?)\s*:\s*(.+)$/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  ndash: "\u2013",
  mdash: "\u2014",
  laquo: "\u00AB",
  raquo: "\u00BB",
  hellip: "\u2026",
  shy: "\u00AD",
};

/**
 * HTMLRewriter (lol_html) не декодує character references у тексті — «17:00 &#8211; 21:00»
 * зі сторінки zoe.com.ua потрапляє в парсер як литеральний текст. Декодуємо самі.
 */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 1 || codePoint > 0x10ffff) return match;
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function hasNoSchedule(text: string): boolean {
  const upper = text.toUpperCase();
  return NO_SCHEDULE_MARKERS.some((marker) => upper.includes(marker));
}

export function isBusinessPost(post: OutagePost): boolean {
  const title = post.title.toUpperCase();
  const text = post.text.toUpperCase();
  return (
    BUSINESS_TITLE_MARKERS.some((marker) => title.includes(marker)) ||
    BUSINESS_TEXT_MARKERS.some((marker) => text.includes(marker))
  );
}

export function parseQueueLines(text: string): Record<string, string> {
  const queues: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const match = QUEUE_LINE_RE.exec(rawLine.trim());
    if (match === null) continue;
    const queue = match[1] as string;
    // На реальній сторінці трапляються тире – (U+2013) та — (U+2014): уніфікуємо
    const times = (match[2] as string)
      .replace(/\s+/g, " ")
      .replace(/[–—]/g, "-")
      .trim();
    if (!(queue in queues)) queues[queue] = times;
  }
  return queues;
}

export function scenarioFor(post: OutagePost, queue: string): Scenario {
  if (hasNoSchedule(post.text)) return { kind: SCENARIO_NO_SCHEDULE, times: null };
  const times = post.queues[queue];
  if (times !== undefined) return { kind: SCENARIO_PRESENT, times };
  return { kind: SCENARIO_ABSENT, times: null };
}

const MONTHS_GENITIVE = [
  "січня",
  "лютого",
  "березня",
  "квітня",
  "травня",
  "червня",
  "липня",
  "серпня",
  "вересня",
  "жовтня",
  "листопада",
  "грудня",
];

/** Дата з заголовка поста («…НА 17 ЖОВТНЯ…» → 17 жовтня). Місяць — 1–12. */
export function parseTitleDate(title: string): { day: number; month: number } | null {
  const lowered = title.toLowerCase();
  for (let index = 0; index < MONTHS_GENITIVE.length; index += 1) {
    const monthName = MONTHS_GENITIVE[index];
    if (monthName === undefined) continue;
    const match = new RegExp(`(\\d{1,2})\\s+${monthName}`).exec(lowered);
    if (match !== null) return { day: Number(match[1] as string), month: index + 1 };
  }
  return null;
}

/** Назва місяця в родовому відмінку: 10 → «жовтня» (як у заголовках постів). */
export function monthGenitive(month: number): string {
  return MONTHS_GENITIVE[month - 1] ?? "";
}

/**
 * Визначає, чи є новий пост оновленням раніше опублікованого графіка:
 * - Той самий id статті (відредаговано на сайті)
 * - Або дата в заголовку збігається з датою попереднього поста
 * - Або заголовок містить слово «оновлен» (якщо дата не розпізнана)
 */
export function isScheduleUpdate(
  previousPostId: string | null,
  previousTitle: string | null,
  newPost: OutagePost,
): boolean {
  if (previousPostId === null) return false;
  if (previousPostId === newPost.id) return true;

  const prevDate = previousTitle ? parseTitleDate(previousTitle) : null;
  const newDate = parseTitleDate(newPost.title);

  // Якщо в обох постах є дата і вона різна — це новий день, а не оновлення
  if (
    prevDate !== null &&
    newDate !== null &&
    (prevDate.day !== newDate.day || prevDate.month !== newDate.month)
  ) {
    return false;
  }

  // Якщо дата однакова — це оновлення графіка на той самий день
  if (
    prevDate !== null &&
    newDate !== null &&
    prevDate.day === newDate.day &&
    prevDate.month === newDate.month
  ) {
    return true;
  }

  return newPost.title.toLowerCase().includes("оновлен");
}

interface ArticleDraft {
  id: string;
  title: string;
  text: string;
}

/**
 * Витягує всі статті сторінки через HTMLRewriter (стрімінговий парсер Workers).
 * Новий рядок додається на межах <br> та блокових елементів, як у get_text(separator="\n").
 */
export async function parsePage(html: string): Promise<OutagePost[]> {
  const state = {
    current: null as ArticleDraft | null,
    h2Depth: 0,
    contentDepth: 0,
    drafts: [] as ArticleDraft[],
  };

  const whenInContent = (fn: (current: ArticleDraft) => void) => () => {
    if (state.current !== null && state.contentDepth > 0) fn(state.current);
  };

  const rewriter = new HTMLRewriter()
    .on("article", {
      element(el) {
        state.current = { id: el.getAttribute("id") ?? "", title: "", text: "" };
        el.onEndTag(() => {
          if (state.current !== null) state.drafts.push(state.current);
          state.current = null;
        });
      },
    })
    .on("h2", {
      element(el) {
        state.h2Depth += 1;
        el.onEndTag(() => {
          state.h2Depth -= 1;
        });
      },
      text(chunk) {
        if (state.current !== null && state.h2Depth > 0) state.current.title += chunk.text;
      },
    })
    .on(".content", {
      element(el) {
        state.contentDepth += 1;
        el.onEndTag(() => {
          state.contentDepth -= 1;
          if (state.current !== null && state.contentDepth === 0) state.current.text += "\n";
        });
      },
      text(chunk) {
        if (state.current !== null && state.contentDepth > 0) state.current.text += chunk.text;
      },
    })
    // NB: <br> — void-елемент без кінцевого тега; onEndTag на ньому змушує
    // HTMLRewriter падати («Parser error: No end tag»), тому новий рядок додаємо
    // одразу при відкритті тега (після normalizeText результат той самий).
    .on("br", {
      element: whenInContent((current) => (current.text += "\n")),
    })
    .on("p", {
      element(el) {
        el.onEndTag(whenInContent((current) => (current.text += "\n")));
      },
    });

  await rewriter.transform(new Response(html)).text();

  return state.drafts
    .filter((draft) => draft.id !== "")
    .map((draft) => {
      const text = normalizeText(decodeHtmlEntities(draft.text));
      const title = decodeHtmlEntities(draft.title.trim());
      return { id: draft.id, title, text, queues: parseQueueLines(text) };
    });
}

/** Прибирає порожні рядки та зайві пробіли (аналог strip=True у Python). */
function normalizeText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}
