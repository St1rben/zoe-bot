import { env, exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleUpdate } from "../src/commands";
import { getChatQueues, listChats, emptyMeta, putMeta } from "../src/state";
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

/** Натискання інлайн-кнопки вибору черг. */
async function sendCallback(data: string, messageId = 10): Promise<Response> {
  return await exports.default.fetch("https://bot.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "test-secret",
    },
    body: JSON.stringify({
      update_id: 99,
      callback_query: {
        id: `cb-${data}-${messageId}`,
        data,
        message: { message_id: messageId, chat: { id: CHAT_ID, type: "private" } },
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

  it("/start реєструє чат і вітає з дефолтною чергою", async () => {
    const net = installNetworkStub({ page: "" });
    const response = await sendUpdate("/start");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    expect(await getChatQueues(env, CHAT_ID)).toBeNull();
    const chats = await listChats(env);
    expect(chats.some((chat) => chat.chatId === CHAT_ID)).toBe(true);

    expect(net.telegramCalls).toHaveLength(1);
    expect(net.telegramCalls[0]!.chatId).toBe(CHAT_ID);
    expect(net.telegramCalls[0]!.text).toContain("ZOE Outage Bot");
    expect(net.telegramCalls[0]!.text).toContain("Ваші черги: <b>5.1</b>");
  });

  it("/queue 4.2 замінює набір, /queue показує список з кнопками", async () => {
    const net = installNetworkStub({ page: "" });
    await sendUpdate("/queue 4.2");
    expect(await getChatQueues(env, CHAT_ID)).toEqual(["4.2"]);
    // останнє повідомлення — актуальний графік, перед ним — підтвердження заміни
    expect(net.telegramCalls.at(-1)!.text).toContain("Відстежувана черга: <b>4.2</b>");

    await sendUpdate("/queue");
    const last = net.telegramCalls.at(-1)!;
    expect(last.text).toContain("Відстежуються: <b>4.2</b>");
    expect(last.text).not.toContain("за замовчуванням");
    // кнопки вибору прийшли з тим самим повідомленням
    const lastApi = net.apiCalls.at(-1)!;
    expect(lastApi.method).toBe("sendMessage");
    const keyboard = lastApi.body.reply_markup as
      | { inline_keyboard?: { text: string; callback_data: string }[][] }
      | undefined;
    expect(keyboard?.inline_keyboard?.flat().some((b) => b.callback_data === "qt:4.2")).toBe(true);
  });

  it("/queue add додає кілька черг одночасно (дефолт залишається)", async () => {
    const net = installNetworkStub({ page: "" });
    await sendUpdate("/queue add 3.1 6.2 3.1");
    // дефолтна 5.1 теж у наборі: додавання — адитивне
    expect(await getChatQueues(env, CHAT_ID)).toEqual(["5.1", "3.1", "6.2"]);
    expect(net.telegramCalls.at(-1)!.text).toContain("Додано черги: <b>3.1, 6.2</b>");
  });

  it("/queue add вже відстежуваних — попередження без змін", async () => {
    const net = installNetworkStub({ page: "" });
    await sendUpdate("/queue 4.2");
    const before = await getChatQueues(env, CHAT_ID);
    await sendUpdate("/queue add 4.2");
    expect(net.telegramCalls.at(-1)!.text).toContain("вже відстежуються");
    expect(await getChatQueues(env, CHAT_ID)).toEqual(before);
  });

  it("/queue remove прибирає черги; залишок з однієї дефолтної — назад до дефолту", async () => {
    const net = installNetworkStub({ page: "" });
    await sendUpdate("/queue add 3.1 6.2");
    await sendUpdate("/queue remove 3.1");
    expect(await getChatQueues(env, CHAT_ID)).toEqual(["5.1", "6.2"]);
    expect(net.telegramCalls.at(-1)!.text).toContain("Прибрано чергу: <b>3.1</b>");

    await sendUpdate("/queue remove 6.2");
    expect(await getChatQueues(env, CHAT_ID)).toBeNull();
    expect(net.telegramCalls.at(-1)!.text).toContain("Тепер відстежується черга за замовчуванням: <b>5.1</b>");
  });

  it("/queue remove неіснуючих — попередження", async () => {
    const net = installNetworkStub({ page: "" });
    await sendUpdate("/queue remove 4.2");
    expect(net.telegramCalls.at(-1)!.text).toContain("прибирати нічого");
  });

  it("дефолтну чергу не прибрати, поки набір не заданий явно", async () => {
    const net = installNetworkStub({ page: "" });
    await sendUpdate("/queue remove 5.1");
    expect(net.telegramCalls.at(-1)!.text).toContain("за замовчуванням");
    expect(await getChatQueues(env, CHAT_ID)).toBeNull();
  });

  it("/queue зі сміттям — підказка, набір не змінюється", async () => {
    const net = installNetworkStub({ page: "" });
    await sendUpdate("/queue abc");
    expect(await getChatQueues(env, CHAT_ID)).toBeNull();
    expect(net.telegramCalls.at(-1)!.text).toContain("не схоже на номер черги");

    await sendUpdate("/queue add abc");
    expect(net.telegramCalls.at(-1)!.text).toContain("не схоже на номер черги");
  });

  it("кнопка qt:4.2 додає чергу та оновлює повідомлення", async () => {
    const net = installNetworkStub({ page: "" });
    const response = await sendCallback("qt:4.2");
    expect(response.status).toBe(200);

    expect(await getChatQueues(env, CHAT_ID)).toEqual(["4.2", "5.1"]);

    const edit = net.apiCalls.find((call) => call.method === "editMessageText");
    expect(edit).toBeDefined();
    expect(edit!.body.chat_id).toBe(CHAT_ID);
    expect(edit!.body.message_id).toBe(10);
    const keyboard = edit!.body.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    const toggle = keyboard.inline_keyboard.flat().find((b) => b.callback_data === "qt:4.2");
    expect(toggle?.text).toBe("✅ 4.2");

    const answer = net.apiCalls.find((call) => call.method === "answerCallbackQuery");
    expect(answer).toBeDefined();
    expect(answer!.body.callback_query_id).toBe("cb-qt:4.2-10");
    expect(answer!.body.text).toBe("✅ Додано 4.2");
  });

  it("кнопки: повторний тап прибирає чергу, остання — назад до дефолту", async () => {
    const net = installNetworkStub({ page: "" });
    await sendCallback("qt:4.2");
    await sendCallback("qt:5.1");
    expect(await getChatQueues(env, CHAT_ID)).toEqual(["4.2"]);
    const answer = net.apiCalls.filter((call) => call.method === "answerCallbackQuery").at(-1);
    expect(answer!.body.text).toBe("🗑 Прибрано 5.1");

    await sendCallback("qt:4.2");
    expect(await getChatQueues(env, CHAT_ID)).toBeNull();
    const lastAnswer = net.apiCalls.filter((call) => call.method === "answerCallbackQuery").at(-1);
    expect(lastAnswer!.body.text).toBe("🗑 Прибрано 4.2");

    // повідомлення після повернення до дефолту — саме «за замовчуванням»
    const lastEdit = net.apiCalls.filter((call) => call.method === "editMessageText").at(-1);
    expect(lastEdit!.body.text).toContain("Зараз — черга за замовчуванням: <b>5.1</b>");
  });

  it("тап по дефолтній черзі до явного набору — пояснення без змін", async () => {
    const net = installNetworkStub({ page: "" });
    await sendCallback("qt:5.1");
    expect(await getChatQueues(env, CHAT_ID)).toBeNull();
    const answer = net.apiCalls.find((call) => call.method === "answerCallbackQuery");
    expect(answer!.body.text).toContain("за замовчуванням");
  });

  it("невідомий callback_data — лише answerCallbackQuery без змін", async () => {
    const net = installNetworkStub({ page: "" });
    await sendCallback("zz:1.1");
    expect(await getChatQueues(env, CHAT_ID)).toBeNull();
    expect(net.apiCalls.some((call) => call.method === "answerCallbackQuery")).toBe(true);
    expect(net.apiCalls.some((call) => call.method === "editMessageText")).toBe(false);
  });

  it("/status і /help відповідають", async () => {
    const net = installNetworkStub({ page: "" });
    await sendUpdate("/queue 4.2");

    await sendUpdate("/status");
    const status = net.telegramCalls.at(-1)!.text;
    expect(status).toContain("Статус бота");
    expect(status).toContain("Черги: <b>4.2</b>");

    await sendUpdate("/help");
    expect(net.telegramCalls.at(-1)!.text).toContain("Команди");
    expect(net.telegramCalls.at(-1)!.text).toContain("/queue add");
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

describe("ADMIN_IDS: зміна черг лише для адміна", () => {
  const ADMIN_ID = 724390773;

  function restrictedEnv(): Env {
    return {
      STATE: env.STATE,
      BOT_TOKEN: "test-token",
      QUEUE: "5.1",
      DIGEST_TIME: "",
      DIGEST_TZ: "Europe/Kyiv",
      DRY_RUN: "0",
      ADMIN_IDS: String(ADMIN_ID),
    } as unknown as Env;
  }

  async function sendAs(e: Env, text: string, fromId: number): Promise<void> {
    await handleUpdate(e, {
      update_id: 500,
      message: {
        message_id: 50,
        chat: { id: CHAT_ID, type: "group" },
        from: { id: fromId },
        text,
      },
    });
  }

  async function tapAs(e: Env, data: string, fromId: number): Promise<void> {
    await handleUpdate(e, {
      update_id: 501,
      callback_query: {
        id: `cb-${fromId}-${data}`,
        from: { id: fromId },
        data,
        message: { message_id: 50, chat: { id: CHAT_ID, type: "group" } },
      },
    });
  }

  it("не-адмін: add/remove/кнопки заборонені, перегляд відкритий", async () => {
    const net = installNetworkStub({ page: "" });
    const e = restrictedEnv();

    await sendAs(e, "/queue add 4.2", 999);
    expect(await getChatQueues(env, CHAT_ID)).toBeNull();
    expect(net.telegramCalls.at(-1)!.text).toContain("лише адміністратор");

    await sendAs(e, "/queue remove 5.1", 999);
    expect(net.telegramCalls.at(-1)!.text).toContain("лише адміністратор");

    // перегляд — відкритий
    await sendAs(e, "/queue", 999);
    expect(net.telegramCalls.at(-1)!.text).toContain("Черги цього чату");

    // кнопка не-адміном — тост-відмова, без редагування і без змін
    await tapAs(e, "qt:4.2", 999);
    const answer = net.apiCalls.find((call) => call.method === "answerCallbackQuery");
    expect(answer!.body.text).toContain("адміністратор");
    expect(net.apiCalls.some((call) => call.method === "editMessageText")).toBe(false);
    expect(await getChatQueues(env, CHAT_ID)).toBeNull();
  });

  it("адмін змінює черги і командами, і кнопками", async () => {
    const net = installNetworkStub({ page: "" });
    const e = restrictedEnv();

    await sendAs(e, "/queue add 4.2", ADMIN_ID);
    expect(await getChatQueues(env, CHAT_ID)).toEqual(["5.1", "4.2"]);

    await tapAs(e, "qt:4.2", ADMIN_ID);
    expect(await getChatQueues(env, CHAT_ID)).toBeNull();
    const edit = net.apiCalls.filter((call) => call.method === "editMessageText").at(-1);
    expect(edit!.body.text).toContain("Зараз — черга за замовчуванням: <b>5.1</b>");
  });
});

describe("health", () => {
  it("GET /health віддає JSON зі станом", async () => {
    installNetworkStub({ page: "" });
    const response = await exports.default.fetch("https://bot.example/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.10.1");
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
