# ZOE Outage Bot на Cloudflare Workers

Та сама логіка, що й у Python-версії, але без сервера: воркер = мозок бота
(вебхук команд, дедуплікація, розсилка, стан у Workers KV), а сторінку
приносять безкоштовні «очі» — GitHub Actions тягне її через Tor із українським
виходом і штовхає HTML у `POST /ingest`. Картка не потрібна.

```
POST /telegram   # вебхук Telegram: /start /status /queue /help
POST /ingest     # HTML сторінки від фетчера (GitHub Actions + Tor)
GET  /health     # JSON-стан воркера
cron * * * * *   # сторож: якщо /ingest мовчить > 8 хв, будить zoe-fetch.yml
```

## Чому це влізає у безкоштовний тариф

| Ресурс | Використання бота | Ліміт Free |
|---|---|---|
| Cron-запуски | 1 440/добу (сторож) | не тарифікуються окремо |
| KV читання | ~10–15 тис./добу | 100 тис./добу |
| KV записи | ~300–500/добу (бейкон + зміни) | 1 тис./добу |
| CPU | ~10–50 мс на запуск | 10 мс CPU на виклик* |
| GitHub Actions | ~300 запусків/добу × ~1 хв | публічні репозиторії — безлімітно |

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

## Як завантажується сторінка («очі» бота)

zoe.com.ua віддає HTML лише українським мережам, тому CF сам сторінку дістати
не може. Робочий безкоштовний варіант — **GitHub Actions + Tor**:

- `.github/workflows/zoe-fetch.yml` — кожні ~5 хвилин (і за командою сторожового
  cron-а) піднімає Tor з `ExitNodes {ua} StrictNodes 1`, завантажує
  `https://www.zoe.com.ua/outage/` (`curl -k`: у сайту неповний TLS-ланцюжок)
  і відправляє HTML у `POST /ingest` (токен `INGEST_TOKEN` із секретів
  репозиторію).
- `.github/workflows/keepalive.yml` — раз на місяць робить крихітний коміт,
  щоб GitHub не вимкнув розклад після 60 днів без активності.
- **Сторож**: GitHub-розклад буває ненадійним, тому cron у воркері щохвилини
  перевіряє `meta.lastIngestAt`; якщо дані старші 8 хвилин — викликає
  `workflow_dispatch` через GitHub API (секрет воркера `GITHUB_TOKEN`).

Налаштування GitHub:

| Що | Де | Значення |
|---|---|---|
| `INGEST_TOKEN` | Settings → Secrets → Actions | те саме значення, що в секреті воркера |
| Public-репозиторій | Settings → General → Danger Zone | щоб хвилини Actions були безлімітні |

## Змінні та секрети

| Ім'я | Тип | За замовчуванням | Опис |
|---|---|---|---|
| `BOT_TOKEN` | secret | — | токен бота |
| `TELEGRAM_WEBHOOK_SECRET` | secret | — | перевірка заголовка `X-Telegram-Bot-Api-Secret-Token` |
| `CHAT_ID` | secret | — | чат за замовчуванням (можна й без нього — `/start` у чаті) |
| `INGEST_TOKEN` | secret | — | токен для `POST /ingest` (фетчер: GitHub Actions або маячок) |
| `GITHUB_TOKEN` | secret | — | токен GitHub для `workflow_dispatch` (сторож будить zoe-fetch.yml) |
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
- **Фетчер**: `POST /ingest` (авторизація `X-Ingest-Token`) приймає HTML від
  GitHub Actions (Tor із укр. виходом — основні «очі») або від `ua-fetcher/cron.php`
  на укр. хостингу (альтернатива). Незмінний контент (SHA-256 від
  id/заголовка/тексту поста) пропускається — KV-записи й перебір чатів
  витрачаються лише на зміни.
- **Миттєві відповіді**: `/start` та `/queue` одразу показують актуальний графік
  із `meta.lastPostText`, не чекаючи наступної перевірки.
- **Свіжість у `/status`**: якщо найсвіжіший пост не за сьогодні (графік на
  поточний день ще не публікували), `/status` попереджає про це і показує дату
  останніх даних — щоб старі вікна не виглядали як «поточний стан».
- **Черги чатів**: `chat:{chatId}` з `metadata.queue` (порівнюється списком
  KV без додаткових читань). `CHAT_ID` діє як «віртуальна» підписка — без
  запису в KV.
- **Парсинг**: `HTMLRewriter` (стрімінг) — беремо першу статтю не для
  бізнесу, заголовок з `<h2>`, текст з `.content`, рядки черг регексом.
- **Дайджест**: раз на добу у `DIGEST_TIME` за `DIGEST_TZ`, з контролем
  «вже надіслано сьогодні» в `meta.digestDate`.

## Обмеження

- **Гео-блок**: `zoe.com.ua/outage` відповідає **лише українським мережам**
  (check-host.net: усі 25 зарубіжних вузлів — `Connection timed out`, укр. —
  `200 OK`; пробний `fetch()` із CF — таймаут на всіх варіантах). Тому сторінку
  завантажують «очі»: GitHub Actions через Tor із укр. виходом (перевірено —
  різні укр. exit-вузли повертають ту саму сторінку). Запасний варіант —
  маячок на укр. хостингу (`ua-fetcher/`).
- **TLS**: `zoe.com.ua` віддає **неповний ланцюжок** сертифікатів (лише leaf):
  у PHP маячка перевірку сертифіката вимкнено (`CURLOPT_SSL_VERIFYPEER`),
  у Python-версії — той самий fallback.
- **Eventual consistency KV**: записи можуть до 60 с не бачитись в інших
  регіонах. Для дедуплікації це некритично (гірший випадок — одне повторне
  повідомлення при гонці), але пам'ятайте про це.
