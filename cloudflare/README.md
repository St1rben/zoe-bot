# ZOE Outage Bot на Cloudflare Workers

Та сама логіка, що й у Python-версії, але без сервера: один воркер = вебхук
команд + cron-перевірка щохвилини, стан у Workers KV. Безкоштовний тариф
Cloudflare, **картка не потрібна**.

```
POST /telegram   # вебхук Telegram: /start /status /queue /help
GET  /health     # JSON-стан воркера
cron * * * * *   # перевірка zoe.com.ua/outage щохвилини
```

## Чому це влізає у безкоштовний тариф

| Ресурс | Використання бота | Ліміт Free |
|---|---|---|
| Cron-запуски | 1 440/добу | не тарифікуються окремо |
| KV читання | ~10–15 тис./добу | 100 тис./добу |
| KV записи | лише при змінах (~кілька/добу) | 1 тис./добу |
| CPU | ~10–50 мс на запуск | 10 мс CPU на виклик* |

\* Парсинг сторінки — це переважно I/O (fetch + стрімінг), CPU витрачається на
HTMLRewriter і регулярки. Фактичне споживання видно у дашборді (Metrics →
CPU time). Якщо колись перевищить — платний тариф $5/міс.

## Деплой (10 хвилин)

Потрібні Node 20+ і акаунт Cloudflare (без картки).

```bash
cd cloudflare
npm install

npx wrangler login                     # відкриє браузер
npx wrangler kv namespace create STATE # вставте отриманий id у wrangler.toml

npx wrangler secret put BOT_TOKEN                 # токен від @BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # вигадайте випадковий рядок
npx wrangler secret put CHAT_ID                   # (необов'язково) чат за замовчуванням

npx wrangler deploy                    # надрукує URL воркера
```

Після деплою зареєструйте вебхук (підставте свій URL):

```bash
WORKER_URL=https://zoe-outage-bot.<account>.workers.dev \
BOT_TOKEN=<токен> \
TELEGRAM_WEBHOOK_SECRET=<секрет> \
npm run set-webhook
```

Перевірка: `curl https://<worker>/health` → `{"status":"ok",...}`.
Cron починає працювати одразу після деплою; щоб зареєструвати чат — напишіть
боту `/start` або задайте `CHAT_ID`.

## Змінні та секрети

| Ім'я | Тип | За замовчуванням | Опис |
|---|---|---|---|
| `BOT_TOKEN` | secret | — | токен бота |
| `TELEGRAM_WEBHOOK_SECRET` | secret | — | перевірка заголовка `X-Telegram-Bot-Api-Secret-Token` |
| `CHAT_ID` | secret | — | чат за замовчуванням (можна й без нього — `/start` у чаті) |
| `QUEUE` | var | `5.1` | черга за замовчуванням |
| `DIGEST_TIME` | var | — | час щоденного нагадування (`20:00`), порожньо = вимкнено |
| `DIGEST_TZ` | var | `Europe/Kyiv` | таймзона для дайджесту |
| `DRY_RUN` | var | `0` | `1` — не надсилати, лише лог |

## Локальна розробка

```bash
cp .dev.vars.example .dev.vars   # DRY_RUN=1, фейкові секрети
npm run dev                      # wrangler dev --test-scheduled
```

- Змусити cron-запуск зараз:
  `curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"`
- Надіслати команду:
  ```bash
  curl -X POST http://127.0.0.1:8787/telegram \
    -H "content-type: application/json" \
    -H "x-telegram-bot-api-secret-token: dev-secret" \
    -d '{"update_id":1,"message":{"message_id":1,"chat":{"id":111,"type":"private"},"text":"/start"}}'
  ```
- У режимі `DRY_RUN=1` повідомлення друкуються в лог, у Telegram не йдуть.
- ⚠️ Живий `fetch()` до zoe.com.ua з локального worderd не працює — сайт
  віддає неповний ланцюжок TLS, а kj-tls не вміє AIA (див. «Обмеження»).
  Для живої перевірки: `npx wrangler dev --remote` (потрібен `wrangler login`,
  запускається на бойовому edge Cloudflare).

## Тести

Тести виконуються у справжньому рантаймі workerd (через
`@cloudflare/vitest-plugin`), з реальними KV-біндингами та HTMLRewriter:

```bash
npm test           # vitest run
npm run typecheck  # tsc --noEmit (спершу: npx wrangler types)
```

`worker-configuration.d.ts` генерується `wrangler types` — не комітиться,
перегенеруйте після зміни `wrangler.toml`.

## Як це працює

- **Дедуплікація**: для кожного чату в KV лежить `chat_state:{chatId}` —
  `{postId, queue, scenario, times}`. Повідомлення надсилається лише коли
  все це відрізняється від попереднього стану. Тобто рестарт/передеплой
  не дублює сповіщення, а зміна часу у тому самому пості — надсилається.
- **Черги чатів**: `chat:{chatId}` з `metadata.queue` (порівнюється списком
  KV без додаткових читань). `CHAT_ID` діє як «віртуальна» підписка — без
  запису в KV.
- **Парсинг**: `HTMLRewriter` (стрімінг) — беремо першу статтю не для
  бізнесу, заголовок з `<h2>`, текст з `.content`, рядки черг регексом.
- **Дайджест**: раз на добу у `DIGEST_TIME` за `DIGEST_TZ`, з контролем
  «вже надіслано сьогодні» в `meta.digestDate`.

## Обмеження

- **TLS**: `zoe.com.ua` віддає **неповний ланцюжок** сертифікатів (лише leaf,
  без проміжного) — багаторічна особливість сайту. Windows/curl/Python на
  машині, де проміжний сертифікат уже закешовано, працюють; але TLS-стек
  **локального** workerd (`wrangler dev`) AIA не вміє і падає з `internal
  error` ([capnproto#2583](https://github.com/capnproto/capnproto/issues/2583)).
  На **бойовому edge Cloudflare** той самий `fetch()` такі сервери тягне
  (перевірено в Workers Playground) — тому локальна перевірка живої сторінки
  робиться через `npx wrangler dev --remote` або вже після деплою, а cron
  щохвилини просто повторює спробу. Python-версія має fallback без перевірки
  TLS, тому вона корисна як «план Б».
- **Eventual consistency KV**: записи можуть до 60 с не бачитись в інших
  регіонах. Для дедуплікації це некритично (гірший випадок — одне повторне
  повідомлення при гонці), але пам'ятайте про це.
