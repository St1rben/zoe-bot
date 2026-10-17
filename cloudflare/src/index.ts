/**
 * ZOE Outage Bot — Cloudflare Worker.
 *
 *   POST /telegram  — вебхук Telegram (команди /start /help /queue /status)
 *   GET  /health    — стан воркера (JSON)
 *   cron * * * * * — щохвилинна перевірка zoe.com.ua/outage
 */

import { handleUpdate } from "./commands";
import { runCheck } from "./monitor";
import { getMeta } from "./state";
import type { TelegramUpdate } from "./telegram";
import { VERSION } from "./version";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/telegram") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (!isAuthorizedWebhook(env, request)) return new Response("Forbidden", { status: 403 });

      let update: TelegramUpdate | null = null;
      try {
        update = await request.json<TelegramUpdate>();
      } catch {
        // некоректний JSON — ігноруємо
      }
      if (update !== null) {
        try {
          await handleUpdate(env, update);
        } catch (error) {
          console.error("handleUpdate failed:", error);
        }
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return await healthResponse(env);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const summary = await runCheck(env);
      console.log("check:", JSON.stringify(summary));
    } catch (error) {
      console.error("check failed:", error);
    }
  },
} satisfies ExportedHandler<Env>;

function isAuthorizedWebhook(env: Env, request: Request): boolean {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (secret === undefined || secret === "") return true; // локальна розробка
  const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  return constantTimeEqual(secret, provided);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function healthResponse(env: Env): Promise<Response> {
  try {
    const meta = await getMeta(env);
    return Response.json({
      status: "ok",
      version: VERSION,
      lastPostId: meta.lastPostId,
      lastPostTitle: meta.lastPostTitle,
      updatedAt: meta.updatedAt,
      now: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ status: "degraded", error: String(error) }, { status: 500 });
  }
}
