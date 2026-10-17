// Секрети не потрапляють у wrangler.toml, тому дописуємо їх до Cloudflare.Env вручну.
// Задаються командами:
//   npx wrangler secret put BOT_TOKEN
//   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
//   npx wrangler secret put CHAT_ID            (необов'язково)
declare namespace Cloudflare {
  interface Env {
    BOT_TOKEN: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
    CHAT_ID?: string;
  }
}

// Глобальний Env (worker.toml-змінні + секрети)
interface Env extends Cloudflare.Env {}
