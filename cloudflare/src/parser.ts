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

const NO_SCHEDULE_MARKERS = [
  "НЕ ЗАПЛАНОВАНІ",
  "НЕ ПЛАНУЮТЬСЯ",
  "НЕ ЗАСТОСОВУЮТЬСЯ",
  "НЕ ДІЮТЬ",
];
// Пости «до уваги промисловості та бізнесу» не стосуються населення
const BUSINESS_TITLE_MARKERS = ["ПРОМИСЛОВОСТ", "БІЗНЕС", "ЮРИДИЧНИХ ОСІБ", "ПІДПРИЄМСТВ"];
const BUSINESS_TEXT_MARKERS = ["НЕ СТОСУЮТЬСЯ НАСЕЛЕННЯ", "НЕ СТОСУЮТЬСЯ ПОБУТОВИХ"];

/**
 * Вікно відключень: «08:00 - 10:00», «08.00–10.00», «з 08:00 до 10:00»,
 * години з однією цифрою. Розділювач — будь-яке тире або слово «до».
 */
const TIME_RANGE_RE = /(\d{1,2})[:.](\d{2})\s*(?:[–—−-]|до)\s*(\d{1,2})[:.](\d{2})/g;

/** Номер черги в рядку: «5.1», «5,1» або ціла черга «3». */
const QUEUE_ID_RE = /(\d{1,2}(?:[.,]\d{1,2})?)/g;

/** Допустимий префікс перед номером черги: маркери списку та слово «Черга» / «Підчерга». */
const QUEUE_PREFIX_BEFORE_RE = /^[\s•*·—–−-]*(?:(?:під)?черг[аи]\s*(?:№\s*)?)?$/i;

/** Допустимий розділювач між номером черги та першим вікном часу («: », « — з » тощо). */
const QUEUE_PREFIX_AFTER_RE = /^[\s:.;,—–−-]*(?:з|із)?\s*$/i;

/** Максимум черг, які можна відстежувати в одному чаті (сетка ZOE — 12 черг). */
export const MAX_QUEUES_PER_CHAT = 12;

/**
 * Базовий набір черг для кнопок вибору (реальна сторінка ZOE: 1.1–6.2).
 * Динамічно розширюється чергами з постів (meta.knownQueues), тож якщо
 * оператор додаси нову чергу — вона з'явиться в кнопках автоматично.
 */
export const SEED_QUEUES: readonly string[] = [
  "1.1",
  "1.2",
  "2.1",
  "2.2",
  "3.1",
  "3.2",
  "4.1",
  "4.2",
  "5.1",
  "5.2",
  "6.1",
  "6.2",
];

/** Числове сортування черг («5.2» < «10.1», «3» < «3.1») + дедуплікація. */
export function sortQueues(queues: Iterable<string>): string[] {
  const unique = Array.from(new Set(queues));
  return unique.sort((a, b) => {
    const partsA = a.split(".").map(Number);
    const partsB = b.split(".").map(Number);
    for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
      const left = partsA[index] ?? 0;
      const right = partsB[index] ?? 0;
      if (left !== right) return left - right;
    }
    return 0;
  });
}

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

/**
 * Чи є в поста ознаки актуального графика: рядки черг з часом або
 * маркер «графіки не заплановані». Пости без ознак не надсилаються
 * користувачам — інакше зміна вёрстки виглядала б як «черги відсутні».
 */
export function hasScheduleSignals(post: OutagePost): boolean {
  return Object.keys(post.queues).length > 0 || hasNoSchedule(post.text);
}

/** Нормалізує номер черги: кома → крапка, без пробілів («5, 1» → «5.1»). */
function normalizeQueueId(raw: string): string {
  return raw.replace(/[,\s]+/g, (match) => (match.includes(",") ? "." : "")).trim();
}

function pad2(value: string): string {
  return value.length < 2 ? `0${value}` : value;
}

/** Відновлює вікно в канонічному вигляді «HH:MM - HH:MM» (null — сміття). */
function normalizeWindow(match: RegExpMatchArray): string | null {
  const [, h1, m1, h2, m2] = match;
  if (h1 === undefined || m1 === undefined || h2 === undefined || m2 === undefined) return null;
  const minutes = Number(m1);
  if (minutes > 59 || Number(m2) > 59) return null;
  return `${pad2(h1)}:${m1} - ${pad2(h2)}:${m2}`;
}

/**
 * Витягує черги з тексту поста, толерантно до варіантів оформлення:
 * - префікси: «Черга 5.1:», «• 5.1 —», звичайний «5.1:»;
 * - «5,1» (кома) та цілі номери «3»;
 * - час «08:00» чи «08.00», будь-які тире, «з 08:00 до 10:00»;
 * - перенос частини вікон на наступний рядок (без номера черги —
 *   продовжує попередню, якщо рядок короткий).
 * Рядки без жодного вікна часу ігноруються.
 */
export function parseQueueLines(text: string): Record<string, string> {
  const queues: Record<string, string> = {};
  let lastQueue: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    const ranges = [...line.matchAll(TIME_RANGE_RE)];
    if (ranges.length === 0) {
      lastQueue = null;
      continue;
    }

    const windows = ranges
      .map((match) => normalizeWindow(match))
      .filter((window): window is string => window !== null)
      .join(", ");
    if (windows === "") {
      lastQueue = null;
      continue;
    }

    const firstIndex = ranges[0]?.index ?? 0;
    const prefix = line.slice(0, firstIndex);
    const idMatches = [...prefix.matchAll(QUEUE_ID_RE)];
    const lastMatch = idMatches.at(-1);
    const lastId = lastMatch?.[1];
    const matchIndex = lastMatch?.index ?? 0;
    const beforeId = lastMatch !== undefined ? prefix.slice(0, matchIndex) : "";
    const afterId =
      lastMatch !== undefined ? prefix.slice(matchIndex + lastMatch[0].length) : "";

    const isValidHeader =
      lastId !== undefined &&
      !/^0\d/.test(lastId) &&
      QUEUE_PREFIX_BEFORE_RE.test(beforeId) &&
      QUEUE_PREFIX_AFTER_RE.test(afterId);

    if (isValidHeader && lastId !== undefined) {
      const queue = normalizeQueueId(lastId);
      if (!(queue in queues)) queues[queue] = windows;
      lastQueue = queue;
    } else if (lastQueue !== null && /^[\d:.,\s–—-]*$/.test(prefix.trim())) {
      // Рядок-продовження: лише час (можливо з комою/тире), тексту немає
      queues[lastQueue] = `${queues[lastQueue] ?? ""}, ${windows}`.replace(/^, /, "");
    } else {
      lastQueue = null;
    }
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
  // Числовий фолбек: «17.10», «17.10.2026», «17/10»
  const numeric = /(\d{1,2})[./](\d{1,2})(?:[./]\d{2,4})?/.exec(lowered);
  if (numeric !== null) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return { day, month };
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
  /** Текст із .content — основний шлях. */
  text: string;
  /** Увесь текст статті — фолбек, якщо клас .content зникне. */
  articleText: string;
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
        state.current = { id: el.getAttribute("id") ?? "", title: "", text: "", articleText: "" };
        el.onEndTag(() => {
          if (state.current !== null) state.drafts.push(state.current);
          state.current = null;
        });
      },
      // Фолбек-текст: усе, що є всередині статті (включно з h2 і content)
      text(chunk) {
        if (state.current !== null) state.current.articleText += chunk.text;
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

  return state.drafts.map((draft, index) => {
    const title = decodeHtmlEntities(draft.title.trim());
    // Основний текст — із .content; якщо контейнер зник (зміна вёрстки) —
    // беремо весь текст статті, прибравши рядок заголовка
    const rawText =
      normalizeText(draft.text) !== "" ? draft.text : fallbackArticleText(draft.articleText, title);
    const text = normalizeText(decodeHtmlEntities(rawText));
    // Статті без id (зміна вёрстки) — синтетичний стабільний за порядком id
    const id = draft.id !== "" ? draft.id : `post-auto-${index + 1}`;
    return { id, title, text, queues: parseQueueLines(text) };
  });
}

/** Весь текст статті без рядка заголовка — фолбек, коли .content недоступний. */
function fallbackArticleText(articleText: string, title: string): string {
  const lines = articleText.split("\n").map((line) => line.trim());
  return lines.filter((line) => line !== "" && line !== title).join("\n");
}

/** Прибирає порожні рядки та зайві пробіли (аналог strip=True у Python). */
function normalizeText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}
