import { env, exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getChatQueue, listChats, emptyMeta, putMeta } from "../src/state";
import { installNetworkStub } from "./helpers";

const CHAT_ID = 555;

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

async function sendUpdate(text: string, secret = "test-secret"): Promise<Response> {
  return await exports.default.fetch("https://bot.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: CHAT_ID, type: "private" },
        text,
      },
    }),
  });
}

describe("webhook /telegram", () => {
  it("без правильного секрету — 403", async () => {
    const net = installNetworkStub({ page: "" });
    const response = await sendUpdate("/start", "wrong-secret");
    expect(response.status).toBe(403);
    expect(net.telegramCalls).toHaveLength(0);
  });

  it("/start реєструє чат і вітає з поточною чергою", async () => {
    const net = installNetworkStub({ page: "" });
    const response = await sendUpdate("/start");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    expect(await getChatQueue(env, CHAT_ID)).toBeNull();
    const chats = await listChats(env);
    expect(chats.some((chat) => chat.chatId === CHAT_ID)).toBe(true);

    expect(net.telegramCalls).toHaveLength(1);
    expect(net.telegramCalls[0]!.chatId).toBe(CHAT_ID);
    expect(net.telegramCalls[0]!.text).toContain("ZOE Outage Bot");
    expect(net.telegramCalls[0]!.text).toContain("Ваша черга: <b>5.1</b>");
  });

  it("/queue 4.2 змінює чергу, /queue показує її", async () => {
    const net = installNetworkStub({ page: "" });
    await sendUpdate("/queue 4.2");
    expect(await getChatQueue(env, CHAT_ID)).toBe("4.2");
    expect(net.telegramCalls.at(-1)!.text).toContain("Чергу змінено на <b>4.2</b>");

    await sendUpdate("/queue");
    const last = net.telegramCalls.at(-1)!;
    expect(last.text).toContain("Поточна черга: <b>4.2</b>");
    expect(last.text).toContain("обрано для цього чату");
  });

  it("/queue зі сміттям — підказка, черга не змінюється", async () => {
    const net = installNetworkStub({ page: "" });
    await sendUpdate("/queue abc");
    expect(await getChatQueue(env, CHAT_ID)).toBeNull();
    expect(net.telegramCalls.at(-1)!.text).toContain("не схоже на номер черги");
  });

  it("/status і /help відповідають", async () => {
    const net = installNetworkStub({ page: "" });
    await sendUpdate("/queue 4.2");

    await sendUpdate("/status");
    const status = net.telegramCalls.at(-1)!.text;
    expect(status).toContain("Статус бота");
    expect(status).toContain("Черга: <b>4.2</b>");

    await sendUpdate("/help");
    expect(net.telegramCalls.at(-1)!.text).toContain("Команди");
  });

  it("/status показує, коли сайт востаннє перевіряли", async () => {
    const net = installNetworkStub({ page: "" });
    await putMeta(env, { ...emptyMeta(), lastIngestAt: Date.now() - 210_000 });
    await sendUpdate("/status");
    expect(net.telegramCalls.at(-1)!.text).toContain("Перевірено: 3 хв тому");
  });

  it("додавання бота в групу — тихий вхід без повідомлень, чат зареєстровано", async () => {
    const net = installNetworkStub({ page: "" });
    const response = await exports.default.fetch("https://bot.example/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret",
      },
      body: JSON.stringify({
        update_id: 11,
        my_chat_member: {
          chat: { id: 777, type: "supergroup" },
          old_chat_member: { status: "left" },
          new_chat_member: { status: "member" },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(net.textsFor(777)).toHaveLength(0);

    const chats = await listChats(env);
    expect(chats.some((chat) => chat.chatId === 777)).toBe(true);
  });

  it("видалення бота з групи — без повідомлень", async () => {
    const net = installNetworkStub({ page: "" });
    const response = await exports.default.fetch("https://bot.example/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret",
      },
      body: JSON.stringify({
        update_id: 12,
        my_chat_member: {
          chat: { id: 777, type: "supergroup" },
          old_chat_member: { status: "member" },
          new_chat_member: { status: "left" },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(net.telegramCalls).toHaveLength(0);
  });

  it("некоректний JSON ігнорується без падіння", async () => {
    installNetworkStub({ page: "" });
    const response = await exports.default.fetch("https://bot.example/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: "not-json",
    });
    expect(response.status).toBe(200);
  });
});

describe("health", () => {
  it("GET /health віддає JSON зі станом", async () => {
    installNetworkStub({ page: "" });
    const response = await exports.default.fetch("https://bot.example/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.6.0");
  });

  it("GET /telegram — 405", async () => {
    installNetworkStub({ page: "" });
    const response = await exports.default.fetch("https://bot.example/telegram");
    expect(response.status).toBe(405);
  });

  it("невідомий шлях — 404", async () => {
    installNetworkStub({ page: "" });
    const response = await exports.default.fetch("https://bot.example/nope");
    expect(response.status).toBe(404);
  });
});
