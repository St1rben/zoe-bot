import { env, exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheck, sendDigestIfDue, stalePostNote, timeInZone } from "../src/monitor";
import { isBusinessPost, parsePage, type OutagePost } from "../src/parser";
import { listChats, setChatQueue } from "../src/state";
import {
  BUSINESS_ARTICLE_HTML,
  MIXED_PAGE_HTML,
  SAMPLE_HTML_UPDATED,
} from "./fixtures";
import { installNetworkStub } from "./helpers";

const CHAT_ID = 111;

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

async function firstConsumerPostOrThrow(html: string): Promise<OutagePost> {
  const posts = await parsePage(html);
  const post = posts.find((candidate) => !isBusinessPost(candidate));
  if (post === undefined) throw new Error("немає поста для населення");
  return post;
}

function digestEnv(overrides: { digestTime: string; timeZone: string }): Env {
  return {
    STATE: env.STATE,
    BOT_TOKEN: "test-token",
    QUEUE: "5.1",
    DIGEST_TIME: overrides.digestTime,
    DIGEST_TZ: overrides.timeZone,
    DRY_RUN: "0",
  } as unknown as Env;
}

describe("runCheck", () => {
  it("перший запуск: вітання + оновлення, повторний — без дублів", async () => {
    const net = installNetworkStub({ page: MIXED_PAGE_HTML });
    await setChatQueue(env, CHAT_ID, null);

    const first = await runCheck(env);
    expect(first.ok).toBe(true);
    expect(first.postId).toBe("post-1234");
    expect(first.sentTo).toEqual([CHAT_ID]);
    expect(net.telegramCalls).toHaveLength(2);

    const startup = net.telegramCalls[0]!;
    const update = net.telegramCalls[1]!;
    expect(startup.chatId).toBe(CHAT_ID);
    expect(startup.text).toContain("Бот запущено");
    expect(update.text).toContain("Графік відключень на 17 жовтня");
    expect(update.text).toContain("Черга 5.1: 08:00 - 10:00, 16:00 - 20:00");
    expect(update.text).toContain("zoe.com.ua");

    const second = await runCheck(env);
    expect(second.sentTo).toEqual([]);
    expect(net.telegramCalls).toHaveLength(2);
  });

  it("оновлення часу того самого поста надсилається ще раз", async () => {
    const page = { html: MIXED_PAGE_HTML };
    const net = installNetworkStub({ page: () => page.html });
    await setChatQueue(env, CHAT_ID, null);
    await runCheck(env);
    expect(net.telegramCalls).toHaveLength(2);

    page.html = SAMPLE_HTML_UPDATED;
    const summary = await runCheck(env);
    expect(summary.sentTo).toEqual([CHAT_ID]);
    expect(net.telegramCalls).toHaveLength(3);
    expect(net.telegramCalls[2]!.text).toContain("5.1: 12:00 - 14:00");
  });

  it("коли пост оновлено, але черга чату не змінилася — надсилається сповіщення без змін", async () => {
    const page = { html: MIXED_PAGE_HTML };
    const net = installNetworkStub({ page: () => page.html });
    await setChatQueue(env, CHAT_ID, null);
    await runCheck(env);
    expect(net.telegramCalls).toHaveLength(2);

    page.html = MIXED_PAGE_HTML.replace("1.1: 08:00 - 12:00", "1.1: 09:00 - 13:00");
    const summary = await runCheck(env);
    expect(summary.sentTo).toEqual([CHAT_ID]);
    expect(net.telegramCalls).toHaveLength(3);

    const call = net.telegramCalls[2]!;
    expect(call.text).toContain("Графіки було оновлено, але для нашої черги все так само без змін");
    expect(call.text).toContain("Черга 5.1: 08:00 - 10:00, 16:00 - 20:00");
    expect(call.text).toContain("🔄");

    const nextSummary = await runCheck(env);
    expect(nextSummary.sentTo).toEqual([]);
    expect(net.telegramCalls).toHaveLength(3);
  });

  it("зміна черги чату: /queue одразу надсилає графік нової черги", async () => {
    const net = installNetworkStub({ page: MIXED_PAGE_HTML });
    await setChatQueue(env, CHAT_ID, null);
    await runCheck(env);
    expect(net.telegramCalls).toHaveLength(2);

    const response = await exports.default.fetch("https://bot.example/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret",
      },
      body: JSON.stringify({
        update_id: 3,
        message: { message_id: 3, chat: { id: CHAT_ID, type: "private" }, text: "/queue 5.2" },
      }),
    });
    expect(response.status).toBe(200);
    expect(net.telegramCalls).toHaveLength(4);
    expect(net.telegramCalls[2]!.text).toContain("Чергу змінено на <b>5.2</b>");
    expect(net.telegramCalls[3]!.text).toContain("Черга 5.2: 10:00 - 12:00");
  });

  it("бізнес-пости повністю ігноруються", async () => {
    const net = installNetworkStub({ page: BUSINESS_ARTICLE_HTML });
    await setChatQueue(env, CHAT_ID, null);

    const summary = await runCheck(env);
    expect(summary.skipped).toBe("no_consumer_post");
    expect(net.telegramCalls).toHaveLength(0);
  });

  it("HTTP-помилка сторінки кидає помилку, щоб cron повторив", async () => {
    installNetworkStub({ page: "boom", pageStatus: 503 });
    await expect(runCheck(env)).rejects.toThrow("HTTP 503");
  });
});

describe("sendDigestIfDue", () => {
  it("надсилає у вказаний час один раз на день", async () => {
    const net = installNetworkStub({ page: MIXED_PAGE_HTML });
    await setChatQueue(env, CHAT_ID, null);
    const post = await firstConsumerPostOrThrow(MIXED_PAGE_HTML);
    const fake = digestEnv({ digestTime: "20:15", timeZone: "UTC" });

    // не та хвилина — тиша
    expect(await sendDigestIfDue(fake, post, new Date("2026-10-17T19:59:00Z"))).toBe(false);
    expect(net.telegramCalls).toHaveLength(0);

    // та сама хвилина — нагадування
    expect(await sendDigestIfDue(fake, post, new Date("2026-10-17T20:15:30Z"))).toBe(true);
    expect(net.telegramCalls).toHaveLength(1);
    const digest = net.telegramCalls[0]!;
    expect(digest.chatId).toBe(CHAT_ID);
    expect(digest.text).toContain("Нагадування про графік");
    expect(digest.text).toContain("Черга 5.1: 08:00 - 10:00, 16:00 - 20:00");

    // вдруге того ж дня — тиша
    expect(await sendDigestIfDue(fake, post, new Date("2026-10-17T20:15:45Z"))).toBe(false);
    expect(net.telegramCalls).toHaveLength(1);

    // наступний день — знову надсилає
    expect(await sendDigestIfDue(fake, post, new Date("2026-10-18T20:15:05Z"))).toBe(true);
    expect(net.telegramCalls).toHaveLength(2);
  });
});

describe("timeInZone", () => {
  it("UTC", () => {
    expect(timeInZone(new Date("2026-10-17T21:30:00Z"), "UTC")).toEqual({
      date: "2026-10-17",
      hm: "21:30",
    });
  });

  it("Europe/Kyiv: літній час (UTC+3) і перехід через північ", () => {
    expect(timeInZone(new Date("2026-10-17T21:30:00Z"), "Europe/Kyiv")).toEqual({
      date: "2026-10-18",
      hm: "00:30",
    });
  });
});

describe("stalePostNote", () => {
  const oldTitle = "ОНОВЛЕНО ГПВ НА 17 ЖОВТНЯ ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ (оновлено 18:52)";

  it("пост за вчора — попередження з обома датами", () => {
    const note = stalePostNote(oldTitle, new Date("2026-10-18T18:00:00Z"), "Europe/Kyiv");
    expect(note).not.toBeNull();
    expect(note).toContain("На 18 жовтня");
    expect(note).toContain("дані за 17 жовтня");
  });

  it("пост за сьогодні — без попередження", () => {
    expect(stalePostNote(oldTitle, new Date("2026-10-17T18:00:00Z"), "Europe/Kyiv")).toBeNull();
  });

  it("пост на завтра — без попередження", () => {
    const tomorrow = "ОНОВЛЕНО ГПВ НА 18 ЖОВТНЯ ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ";
    expect(stalePostNote(tomorrow, new Date("2026-10-17T18:00:00Z"), "Europe/Kyiv")).toBeNull();
  });

  it("без заголовка або без дати — без попередження", () => {
    expect(stalePostNote(null, new Date("2026-10-18T18:00:00Z"), "Europe/Kyiv")).toBeNull();
    expect(stalePostNote("ОНОВЛЕНО ГПВ", new Date("2026-10-18T18:00:00Z"), "Europe/Kyiv")).toBeNull();
  });
});

describe("listChats", () => {
  it("CHAT_ID діє як віртуальна підписка без запису в KV", async () => {
    const fake = { ...digestEnv({ digestTime: "", timeZone: "UTC" }), CHAT_ID: "-1001964696152" };
    const chats = await listChats(fake);
    expect(chats.some((chat) => chat.chatId === -1001964696152)).toBe(true);
  });
});
