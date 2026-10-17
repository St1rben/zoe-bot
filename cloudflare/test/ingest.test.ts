import { env, exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMeta, setChatQueue } from "../src/state";
import { BUSINESS_ARTICLE_HTML, MIXED_PAGE_HTML, SAMPLE_HTML_UPDATED } from "./fixtures";
import { installNetworkStub } from "./helpers";

const CHAT_ID = 777;

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

function ingest(html: string, token = "test-ingest-token"): Promise<Response> {
  return exports.default.fetch("https://bot.example/ingest", {
    method: "POST",
    headers: { "content-type": "text/html; charset=utf-8", "x-ingest-token": token },
    body: html,
  });
}

/** Доповнює HTML до межі MIN_INGEST_BYTES (коментар парсер не бачить). */
function padded(html: string): string {
  return html + `<!-- ${"x".repeat(600)} -->`;
}

describe("POST /ingest", () => {
  it("без правильного токена — 403", async () => {
    installNetworkStub({ page: "" });
    const response = await ingest(padded(MIXED_PAGE_HTML), "wrong-token");
    expect(response.status).toBe(403);
  });

  it("замале тіло — 400 bad_body", async () => {
    installNetworkStub({ page: "" });
    const response = await ingest("<html>short</html>");
    expect(response.status).toBe(400);
    const body = await response.json<{ error: string }>();
    expect(body.error).toBe("bad_body");
  });

  it("перший ingest: вітання + оновлення, метадані записано", async () => {
    const net = installNetworkStub({ page: "" });
    await setChatQueue(env, CHAT_ID, null);

    const response = await ingest(padded(MIXED_PAGE_HTML));
    expect(response.status).toBe(200);
    const body = await response.json<{ ok: boolean; postId?: string; sentTo: number[] }>();
    expect(body.ok).toBe(true);
    expect(body.postId).toBe("post-1234");
    expect(body.sentTo).toEqual([CHAT_ID]);

    expect(net.telegramCalls).toHaveLength(2);
    expect(net.telegramCalls[0]!.text).toContain("Бот запущено");
    expect(net.telegramCalls[1]!.text).toContain("Черга 5.1: 08:00 - 10:00, 16:00 - 20:00");

    const meta = await getMeta(env);
    expect(meta.lastPostId).toBe("post-1234");
    expect(meta.lastPostText).toContain("5.1: 08:00");
    expect(meta.lastPostSig).toBeTruthy();
    expect(meta.lastIngestAt).not.toBeNull();
  });

  it("той самий HTML удруге — skipped unchanged без дублів", async () => {
    const net = installNetworkStub({ page: "" });
    await setChatQueue(env, CHAT_ID, null);
    await ingest(padded(MIXED_PAGE_HTML));
    expect(net.telegramCalls).toHaveLength(2);

    const response = await ingest(padded(MIXED_PAGE_HTML));
    expect(response.status).toBe(200);
    const body = await response.json<{ skipped?: string }>();
    expect(body.skipped).toBe("unchanged");
    expect(net.telegramCalls).toHaveLength(2);
  });

  it("оновлений HTML — нове повідомлення", async () => {
    const net = installNetworkStub({ page: "" });
    await setChatQueue(env, CHAT_ID, null);
    await ingest(padded(MIXED_PAGE_HTML));
    await ingest(padded(SAMPLE_HTML_UPDATED));
    expect(net.telegramCalls).toHaveLength(3);
    expect(net.telegramCalls.at(-1)!.text).toContain("5.1: 12:00 - 14:00");
  });

  it("лише бізнес-пости — no_consumer_post, без повідомлень", async () => {
    const net = installNetworkStub({ page: "" });
    await setChatQueue(env, CHAT_ID, null);
    const response = await ingest(padded(BUSINESS_ARTICLE_HTML));
    const body = await response.json<{ skipped?: string }>();
    expect(body.skipped).toBe("no_consumer_post");
    expect(net.telegramCalls).toHaveLength(0);
  });

  it("після ingest команда /start одразу показує актуальний графік", async () => {
    const net = installNetworkStub({ page: "" });
    await ingest(padded(MIXED_PAGE_HTML));

    const response = await exports.default.fetch("https://bot.example/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret",
      },
      body: JSON.stringify({
        update_id: 2,
        message: { message_id: 2, chat: { id: 888, type: "private" }, text: "/start" },
      }),
    });
    expect(response.status).toBe(200);

    const texts = net.textsFor(888);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("ZOE Outage Bot");
    expect(texts[1]).toContain("Черга 5.1: 08:00 - 10:00, 16:00 - 20:00");
  });
});
