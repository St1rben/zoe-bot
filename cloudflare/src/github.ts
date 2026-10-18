/**
 * «Пробудження» GitHub-запуску зі сторожового cron-а воркера.
 *
 * zoe-fetch.yml висить на GitHub-розкладі, який може сильно запізнюватись або
 * зовсім замовкати. Воркерний cron працює щохвилини надійно, тому якщо дані
 * від /ingest застрягли — дьоргаємо workflow_dispatch через REST API.
 */

const REPO = "St1rben/zoe-bot";
const WORKFLOW_FILE = "zoe-fetch.yml";
const REF = "main";

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
