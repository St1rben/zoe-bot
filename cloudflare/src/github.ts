/**
 * «Пробудження» GitHub-запуску зі сторожового cron-а воркера.
 *
 * zoe-fetch.yml висить на GitHub-розкладі, який може сильно запізнюватись або
 * зовсім замовкати. Воркерний cron працює щохвилини надійно, тому якщо дані
 * від /ingest застрягли — дьоргаємо workflow_dispatch через REST API.
 */

import { getMeta, putMeta } from "./state";

const REPO = "St1rben/zoe-bot";
const WORKFLOW_FILE = "zoe-fetch.yml";
const REF = "main";

/**
 * Операційність: розклад GitHub (* /5) регулярно запізнюється на 3–10 хв,
 * тому сторож будить zoe-fetch.yml вже при тиші > 3 хв — workflow_dispatch
 * стартує майже одразу, і ефективна затримка «публікація → сповіщення»
 * тримається близько 3–5 хв.
 */
const WAKE_STALE_MS = 3 * 60 * 1000;
/**
 * Не турбувати GitHub частіше ніж раз на 3 хв навіть під час повної тиші.
 * Разом із WAKE_STALE це тримає бюджет KV-записів (~500–800/добу у найгіршому
 * випадку) у межах безкоштовного ліміту 1 000/добу.
 */
const WAKE_MIN_GAP_MS = 3 * 60 * 1000;

/**
 * Сторож: якщо /ingest мовчить довше WAKE_STALE_MS і минуло не менше
 * WAKE_MIN_GAP_MS з останнього пробудження — будить zoe-fetch.yml.
 * Повертає true, якщо запуск було розбужено.
 */
export async function wakeFetchIfStale(env: Env): Promise<boolean> {
  const meta = await getMeta(env);
  const now = Date.now();
  const lastIngestAt = meta.lastIngestAt ?? 0;
  const lastDispatchAt = meta.lastDispatchAt ?? 0;
  if (now - lastIngestAt <= WAKE_STALE_MS || now - lastDispatchAt <= WAKE_MIN_GAP_MS) {
    return false;
  }

  const dispatched = await triggerWorkflowDispatch(env);
  console.log(`wake: dispatched=${dispatched} silentMs=${now - lastIngestAt}`);
  if (dispatched) await putMeta(env, { ...meta, lastDispatchAt: now });
  return dispatched;
}

export async function triggerWorkflowDispatch(env: Env): Promise<boolean> {
  const token = env.GITHUB_TOKEN;
  if (token === undefined || token === "") {
    console.warn("GITHUB_TOKEN не налаштований — не можу розбудити zoe-fetch.yml");
    return false;
  }
  try {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "zoe-outage-bot-worker",
        },
        body: JSON.stringify({ ref: REF }),
      },
    );
    if (response.status !== 204) {
      const body = await response.text().catch(() => "");
      console.error(`GitHub dispatch → ${response.status}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("GitHub dispatch failed:", error);
    return false;
  }
}
