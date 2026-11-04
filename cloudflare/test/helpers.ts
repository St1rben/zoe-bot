/** Хелпери тестів: заглушка outbound-мережі (zoe.com.ua + Telegram API). */

import { vi } from "vitest";
import { OUTAGE_URL } from "../src/parser";

export interface TelegramCall {
  chatId: number;
  text: string;
}

export interface TelegramApiCall {
  /** Метод Bot API: sendMessage, editMessageText, answerCallbackQuery… */
  method: string;
  body: Record<string, unknown>;
}

export interface NetworkStub {
  telegramCalls: TelegramCall[];
  apiCalls: TelegramApiCall[];
  outageRequests: number;
  /** Скільки разів сторож будив zoe-fetch.yml (POST dispatches → 204). */
  githubDispatches: number;
  /** Тексти повідомлень для конкретного чату */
  textsFor(chatId: number): string[];
}

export interface NetworkStubOptions {
  page: string | (() => string);
  pageStatus?: number;
}

export function installNetworkStub(options: NetworkStubOptions): NetworkStub {
  const telegramCalls: TelegramCall[] = [];
  const apiCalls: TelegramApiCall[] = [];
  const stub: NetworkStub = {
    telegramCalls,
    apiCalls,
    outageRequests: 0,
    githubDispatches: 0,
    textsFor: (chatId: number) => telegramCalls.filter((call) => call.chatId === chatId).map((call) => call.text),
  };

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith(OUTAGE_URL)) {
      stub.outageRequests += 1;
      const html = typeof options.page === "function" ? options.page() : options.page;
      return new Response(html, {
        status: options.pageStatus ?? 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.startsWith("https://api.telegram.org/")) {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      // «…/bot<token>/<method>» → метод — останній сегмент шляху
      apiCalls.push({ method: url.split("/").at(-1) ?? "", body });
      if (
        typeof body.chat_id === "number" &&
        typeof body.text === "string"
      ) {
        telegramCalls.push({ chatId: body.chat_id, text: body.text });
      }
      return Response.json({ ok: true, result: { message_id: telegramCalls.length } });
    }

    if (url.startsWith("https://api.github.com/")) {
      stub.githubDispatches += 1;
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  };

  vi.stubGlobal("fetch", fakeFetch);
  return stub;
}
