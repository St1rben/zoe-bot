/**
 * ZOE Outage Bot — Cloudflare Worker.
 *
 *   POST /telegram  — вебхук Telegram (команди /start /help /queue /status)
 *   POST /ingest    — HTML сторінки від «очей» бота (GitHub Actions + Tor)
 *   GET  /health    — стан воркера (JSON)
 *   cron * * * * * — сторож: якщо /ingest довго мовчить, будить zoe-fetch.yml
 */

import { handleUpdate } from "./commands";
import { triggerWorkflowDispatch } from "./github";
import { processHtml } from "./monitor";
import { getMeta, putMeta } from "./state";
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

    if (url.pathname === "/ingest") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      return await ingestResponse(env, request);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return await healthResponse(env);
    }

    return new Response("Not Found", { status: 404 });
  },

  /**
   * Воркер фізично не може завантажити zoe (гео-блок), тому його cron працює
   * сторожем: якщо /ingest не приносив дані довше WAKE_STALE_MS, дьоргаємо
   * запуск zoe-fetch.yml на GitHub через workflow_dispatch.
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const meta = await getMeta(env);
      const now = Date.now();
      const lastIngestAt = meta.lastIngestAt ?? 0;
      const lastDispatchAt = meta.lastDispatchAt ?? 0;
      if (now - lastIngestAt > WAKE_STALE_MS && now - lastDispatchAt > WAKE_MIN_GAP_MS) {
        const dispatched = await triggerWorkflowDispatch(env);
        console.log(`wake: dispatched=${dispatched} silentMs=${now - lastIngestAt}`);
        if (dispatched) await putMeta(env, { ...meta, lastDispatchAt: now });
      }
    } catch (error) {
      console.error("scheduled wake failed:", error);
    }
  },
} satisfies ExportedHandler<Env>;

/** Як довго /ingest може мовчати, перш ніж сторож будить zoe-fetch.yml. */
const WAKE_STALE_MS = 8 * 60 * 1000;
/** Не турбувати GitHub частіше ніж раз на 5 хв навіть під час повної тиші. */
const WAKE_MIN_GAP_MS = 5 * 60 * 1000;

/** Межі тіла /ingest: жива сторінка zoe ~120 КБ; менше 512 Б — явно не сторінка. */
const MIN_INGEST_BYTES = 512;
const MAX_INGEST_BYTES = 2_000_000;

async function ingestResponse(env: Env, request: Request): Promise<Response> {
  const secret = env.INGEST_TOKEN;
  if (secret === undefined || secret === "") {
    return new Response("Ingest is not configured", { status: 503 });
  }
  const provided = request.headers.get("x-ingest-token") ?? "";
  if (!constantTimeEqual(secret, provided)) return new Response("Forbidden", { status: 403 });

  const html = await request.text();
  if (html.length < MIN_INGEST_BYTES || html.length > MAX_INGEST_BYTES) {
    return Response.json({ ok: false, error: "bad_body", length: html.length }, { status: 400 });
  }

  try {
    const summary = await processHtml(env, html, "ingest");
    console.log("ingest:", JSON.stringify(summary));
    return Response.json(summary);
  } catch (error) {
    console.error("ingest failed:", error);
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

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
      lastIngestAt: meta.lastIngestAt ?? null,
      lastDispatchAt: meta.lastDispatchAt ?? null,
      now: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ status: "degraded", error: String(error) }, { status: 500 });
  }
}
