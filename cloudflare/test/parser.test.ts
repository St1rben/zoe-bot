import { describe, expect, it } from "vitest";
import {
  decodeHtmlEntities,
  hasNoSchedule,
  isBusinessPost,
  isScheduleUpdate,
  monthGenitive,
  parsePage,
  parseQueueLines,
  parseTitleDate,
  scenarioFor,
  SCENARIO_ABSENT,
  SCENARIO_NO_SCHEDULE,
  SCENARIO_PRESENT,
  type OutagePost,
} from "../src/parser";
import {
  MIXED_PAGE_HTML,
  NO_ARTICLE_HTML,
  NO_SCHEDULE_HTML,
  SAMPLE_HTML,
} from "./fixtures";

async function consumerPost(html: string): Promise<OutagePost | null> {
  const posts = await parsePage(html);
  return posts.find((post) => !isBusinessPost(post)) ?? null;
}

async function consumerPostOrThrow(html: string): Promise<OutagePost> {
  const post = await consumerPost(html);
  if (post === null) throw new Error("очікувався пост для населення");
  return post;
}

describe("parsePage", () => {
  it("витягує id, заголовок і текст поста", async () => {
    const post = await consumerPostOrThrow(SAMPLE_HTML);
    expect(post.id).toBe("post-1234");
    expect(post.title).toBe("Графік відключень на 17 жовтня");
    // текст із вкладених <p> та рядки черг як прямі текстові вузли
    expect(post.text).toContain("Сьогодні будуть застосовані графіки погодинних відключень:");
    expect(post.text).toContain("5.1: 08:00 - 10:00, 16:00 - 20:00");
    expect(post.text).toContain("Дякуємо за розуміння");
  });

  it("парсить черги з тексту", async () => {
    const post = await consumerPostOrThrow(SAMPLE_HTML);
    expect(post.queues).toEqual({
      "1.1": "08:00 - 12:00",
      "5.1": "08:00 - 10:00, 16:00 - 20:00",
      "5.2": "10:00 - 12:00",
    });
  });

  it("без статей — порожній список", async () => {
    expect(await parsePage(NO_ARTICLE_HTML)).toEqual([]);
    expect(await consumerPost(NO_ARTICLE_HTML)).toBeNull();
  });

  it("стаття без id ігнорується", async () => {
    const html = '<article><h2>Без id</h2><div class="content">5.1: 08:00 - 10:00</div></article>';
    expect(await parsePage(html)).toEqual([]);
    expect(await consumerPost(html)).toBeNull();
  });

  it("пропускає бізнес-пост і бере наступний", async () => {
    const post = await consumerPostOrThrow(MIXED_PAGE_HTML);
    expect(post.id).toBe("post-1234");
  });

  it("повертає всі статті з id у порядку появи", async () => {
    const posts = await parsePage(MIXED_PAGE_HTML);
    expect(posts.map((post) => post.id)).toEqual(["post-2000", "post-1234"]);
  });

  it("якщо всі пости бізнесові — поста для населення немає", async () => {
    const html = MIXED_PAGE_HTML.slice(0, MIXED_PAGE_HTML.indexOf('<article id="post-1234"'));
    expect(await consumerPost(html)).toBeNull();
  });

  it("реальна розмітка zoe: <br /> та тире – не ламають парсинг", async () => {
    const html = `
<article id="post-3000">
  <h2>ОНОВЛЕНО ГПВ НА 17 ЖОВТНЯ</h2>
  <div class="content">
    <p>За терміновою вказівкою НЕК «Укренерго» оновлено графіки.<br />
1.1: 10:30 – 13:30<br />
5.1: 16:30 – 20:30</p>
  </div>
</article>`;
    const post = await consumerPostOrThrow(html);
    expect(post.text).toContain("За терміновою вказівкою НЕК «Укренерго»");
    expect(post.queues).toEqual({ "1.1": "10:30 - 13:30", "5.1": "16:30 - 20:30" });
  });

  it("декодує HTML-entities (&#8211;, &ndash;, &amp;) — HTMLRewriter їх не декодує", async () => {
    const html = `
<article id="post-4000">
  <h2>ГПВ &#8220;26 ЖОВТНЯ&#8221; &mdash; оновлено</h2>
  <div class="content">
    <p>1.1: 10:30 &#8211; 13:30<br />
    5.1: 17:00 &#8211; 21:00</p>
  </div>
</article>`;
    const post = await consumerPostOrThrow(html);
    expect(post.title).toBe("ГПВ \u201C26 ЖОВТНЯ\u201D \u2014 оновлено");
    expect(post.text).toContain("17:00 \u2013 21:00");
    expect(post.queues).toEqual({ "1.1": "10:30 - 13:30", "5.1": "17:00 - 21:00" });
  });

  it("decodeHtmlEntities: невідомі/биті entities лишає як є", async () => {
    expect(decodeHtmlEntities("a &nbsp; b &unknown; &#; &#xZZ; &amp;")).toBe(
      "a \u00A0 b &unknown; &#; &#xZZ; &",
    );
  });
});

describe("isBusinessPost", () => {
  it("визначає бізнес-пост за заголовком", () => {
    const post: OutagePost = {
      id: "1",
      title: "ДО УВАГИ ПРОМИСЛОВОСТІ ТА БІЗНЕСУ",
      text: "без маркерів",
      queues: {},
    };
    expect(isBusinessPost(post)).toBe(true);
  });

  it("визначає бізнес-пост за текстом", () => {
    const post: OutagePost = {
      id: "1",
      title: "Графік на 18 жовтня",
      text: "Дані обмеження НЕ СТОСУЮТЬСЯ НАСЕЛЕННЯ.",
      queues: {},
    };
    expect(isBusinessPost(post)).toBe(true);
  });

  it("пост для населення не є бізнесовим", async () => {
    const post = await consumerPostOrThrow(SAMPLE_HTML);
    expect(isBusinessPost(post)).toBe(false);
  });
});

describe("hasNoSchedule", () => {
  it("знаходить маркер «НЕ ЗАПЛАНОВАНІ»", async () => {
    const post = await consumerPostOrThrow(NO_SCHEDULE_HTML);
    expect(hasNoSchedule(post.text)).toBe(true);
  });

  it("для звичайного поста — false", async () => {
    const post = await consumerPostOrThrow(SAMPLE_HTML);
    expect(hasNoSchedule(post.text)).toBe(false);
  });
});

describe("parseQueueLines", () => {
  it("точні збіги: 15.1, 5.1, 5.10 не плутаються", () => {
    const text = "15.1: 10:00 - 12:00\n5.1 : 08:00 - 10:00\n5.10: 12:00 - 14:00";
    expect(parseQueueLines(text)).toEqual({
      "15.1": "10:00 - 12:00",
      "5.1": "08:00 - 10:00",
      "5.10": "12:00 - 14:00",
    });
  });

  it("ігнорує рядки без точного формату «номер: час»", () => {
    expect(parseQueueLines("Черга 5.1: 08:00 - 10:00\nДякуємо")).toEqual({});
  });

  it("нормалізує тире – та — у звичайний дефіс", () => {
    expect(parseQueueLines("5.1: 08:00 – 10:00, 16:00 — 20:00")).toEqual({
      "5.1": "08:00 - 10:00, 16:00 - 20:00",
    });
  });
});

describe("scenarioFor", () => {
  it("немає графіків — no_schedule", async () => {
    const post = await consumerPostOrThrow(NO_SCHEDULE_HTML);
    expect(scenarioFor(post, "5.1")).toEqual({ kind: SCENARIO_NO_SCHEDULE, times: null });
  });

  it("черга є в графіку — present з часом", async () => {
    const post = await consumerPostOrThrow(SAMPLE_HTML);
    expect(scenarioFor(post, "5.1")).toEqual({
      kind: SCENARIO_PRESENT,
      times: "08:00 - 10:00, 16:00 - 20:00",
    });
  });

  it("черги немає в графіку — absent", async () => {
    const post = await consumerPostOrThrow(SAMPLE_HTML);
    expect(scenarioFor(post, "9.9")).toEqual({ kind: SCENARIO_ABSENT, times: null });
  });
});

describe("parseTitleDate / monthGenitive", () => {
  it("витягує дату зі справжніх заголовків постів", () => {
    expect(
      parseTitleDate("ОНОВЛЕНО ГПВ НА 17 ЖОВТНЯ ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ (оновлено 18:52)"),
    ).toEqual({ day: 17, month: 10 });
    expect(
      parseTitleDate("ГРАФІКИ ПОГОДИННИХ ВІДКЛЮЧЕНЬ НА 06 жовтня НЕ ЗАПЛАНОВАНІ"),
    ).toEqual({ day: 6, month: 10 });
    expect(parseTitleDate("ДО УВАГИ ПРОМИСЛОВОСТІ ТА БІЗНЕСУ 18 ЖОВТНЯ")).toEqual({
      day: 18,
      month: 10,
    });
  });

  it("без дати — null", () => {
    expect(parseTitleDate("ОНОВЛЕНО ГПВ (оновлено 18:52)")).toBeNull();
  });

  it("monthGenitive — родовий відмінок", () => {
    expect(monthGenitive(10)).toBe("жовтня");
    expect(monthGenitive(3)).toBe("березня");
    expect(monthGenitive(13)).toBe("");
  });
});

describe("isScheduleUpdate", () => {
  const dummyPost = (id: string, title: string): OutagePost => ({
    id,
    title,
    text: "some text",
    queues: { "5.1": "17:00 - 21:00" },
  });

  it("перший запуск (previousPostId === null) — не оновлення", () => {
    expect(isScheduleUpdate(null, null, dummyPost("post-1", "ГПВ на 26 жовтня"))).toBe(false);
  });

  it("той самий ID поста — завжди оновлення", () => {
    expect(isScheduleUpdate("post-1", "ГПВ на 26 жовтня", dummyPost("post-1", "ГПВ на 26 жовтня"))).toBe(
      true,
    );
  });

  it("різні ID, але однакова дата в заголовках — оновлення", () => {
    expect(
      isScheduleUpdate(
        "post-1",
        "ГПВ НА 26 ЖОВТНЯ",
        dummyPost("post-2", "ОНОВЛЕНО ГПВ НА 26 ЖОВТНЯ"),
      ),
    ).toBe(true);
  });

  it("різні ID та різні дати — новий день, а не оновлення", () => {
    expect(
      isScheduleUpdate(
        "post-1",
        "ГПВ НА 26 ЖОВТНЯ",
        dummyPost("post-2", "ГПВ НА 27 ЖОВТНЯ"),
      ),
    ).toBe(false);
  });

  it("різні дати навіть зі словом оновлено — новий день", () => {
    expect(
      isScheduleUpdate(
        "post-1",
        "ГПВ НА 26 ЖОВТНЯ",
        dummyPost("post-2", "ОНОВЛЕНО ГПВ НА 27 ЖОВТНЯ"),
      ),
    ).toBe(false);
  });

  it("заголовок без дати, але зі словом «оновлено» — оновлення", () => {
    expect(
      isScheduleUpdate(
        "post-1",
        "Графік відключень",
        dummyPost("post-2", "Оновлено графік відключень"),
      ),
    ).toBe(true);
  });
});
