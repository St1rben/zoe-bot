import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Тестові секрети (у проді задаються через `wrangler secret put`)
        bindings: {
          BOT_TOKEN: "test-token",
          TELEGRAM_WEBHOOK_SECRET: "test-secret",
          QUEUE: "5.1",
          DIGEST_TIME: "",
          DIGEST_TZ: "Europe/Kyiv",
          DRY_RUN: "0",
        },
      },
    }),
  ],
});
