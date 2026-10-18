#!/usr/bin/env node
/**
 * Реєструє вебхук Telegram на задеплоєний воркер і показує getWebhookInfo.
 *
 * Використання (задайте змінні середовища):
 *   BOT_TOKEN=123:ABC \
 *   WORKER_URL=https://zoe-outage-bot.<account>.workers.dev \
 *   TELEGRAM_WEBHOOK_SECRET=<той самий секрет, що й у воркера> \
 *   npm run set-webhook
 */

const { BOT_TOKEN, WORKER_URL, TELEGRAM_WEBHOOK_SECRET } = process.env;

if (!BOT_TOKEN || !WORKER_URL) {
  console.error("Потрібні змінні середовища BOT_TOKEN і WORKER_URL");
  console.error("Приклад: WORKER_URL=https://zoe-outage-bot.example.workers.dev BOT_TOKEN=... npm run set-webhook");
  process.exit(1);
}

const webhookUrl = `${WORKER_URL.replace(/\/+$/, "")}/telegram`;
const body = { url: webhookUrl, allowed_updates: ["message", "my_chat_member"] };
if (TELEGRAM_WEBHOOK_SECRET) body.secret_token = TELEGRAM_WEBHOOK_SECRET;

const setResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const setResult = await setResponse.json();
console.log("setWebhook:", JSON.stringify(setResult, null, 2));

const infoResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
console.log("getWebhookInfo:", JSON.stringify(await infoResponse.json(), null, 2));

if (!setResponse.ok || setResult.ok !== true) process.exit(1);
