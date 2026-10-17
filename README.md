# ZOE Outage Bot

[![CI](https://github.com/St1rben/zoe-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/St1rben/zoe-bot/actions/workflows/ci.yml)

Telegram-бот, який слідкує за графіками погодинних відключень електроенергії
на [zoe.com.ua/outage](https://www.zoe.com.ua/outage/) і пише в чат, коли
з'являється новий пост або змінюється стан вашої черги.

## Можливості

- 🔔 Сповіщення про нові графіки та зміни статусу черги (з'явилась/зникла/не заплановані).
- ⚙️ Своя черга для кожного чату — команда `/queue 5.1`.
- 🗂 Дедуплікація через SQLite: рестарт бота не дублює повідомлення.
- 🌙 Щоденне нагадування про поточний графік (`DIGEST_TIME`, вимкнено за замовчуванням).
- 🔁 Retry з backoff та перевіркою HTTP-статусів.
- 🩺 `/health` з JSON-статусом (uptime, остання перевірка, `tls_verified`).
- 🐳 Docker, CI на GitHub Actions, тести та ruff.

## Як це працює

1. Кожні `CHECK_INTERVAL` секунд бот завантажує сторінку `zoe.com.ua/outage`.
2. Парсить першу статтю **для населення** (пости «до уваги промисловості та
   бізнесу» ігноруються): заголовок, текст і рядки виду `5.1: 08:00 - 10:00`.
3. Для кожного чату визначає сценарій його черги:
   - ☀️ «графіки не заплановані»;
   - 🔴 «черга 5.1: 08:00 - 10:00»;
   - ✅ «черги немає в графіку».
4. Надсилає повідомлення лише якщо стан змінився (стан зберігається в `state.db`).
5. Паралельно працюють Telegram-polling (команди) і health-сервер.

## Швидкий старт

```bash
git clone https://github.com/St1rben/zoe-bot.git
cd zoe-bot

python -m venv .venv
.venv\Scripts\activate          # Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt

copy .env.example .env          # Linux/macOS: cp .env.example .env
# заповніть BOT_TOKEN і CHAT_ID

python bot.py
```

Для локальної перевірки без спаму в чат: `DRY_RUN=1` — бот лише писатиме в лог.

## Змінні середовища

| Змінна | Обов'язкова | За замовчуванням | Опис |
|---|---|---|---|
| `BOT_TOKEN` | ✅ | — | токен бота від @BotFather |
| `CHAT_ID` | ✅ | — | чат/група за замовчуванням (напр. `-1001234567890`) |
| `QUEUE` | | `5.1` | черга за замовчуванням |
| `CHECK_INTERVAL` | | `60` | інтервал перевірки сторінки, с |
| `PORT` | | `8080` | порт health-сервера |
| `LOG_LEVEL` | | `INFO` | `DEBUG`/`INFO`/`WARNING`/`ERROR` |
| `STATE_DB` | | `state.db` | файл стану (SQLite) |
| `REQUEST_TIMEOUT` | | `15` | таймаут запиту, с |
| `RETRY_ATTEMPTS` | | `3` | кількість спроб запиту |
| `DIGEST_TIME` | | — | час щоденного нагадування, напр. `20:00` (порожньо = вимкнено) |
| `DIGEST_TZ` | | `Europe/Kyiv` | таймзона для `DIGEST_TIME` |
| `DRY_RUN` | | `0` | `1` — нічого не надсилати, лише лог |

## Команди

| Команда | Дія |
|---|---|
| `/start` | підписати чат на сповіщення |
| `/status` | стан черги, останній пост, аптайм, помилки |
| `/queue 5.1` | змінити чергу для цього чату |
| `/queue` | показати поточну чергу |
| `/help` | довідка |

## Структура

```
bot.py                # точка входу: python bot.py
zoe_bot/
  app.py              # запуск сервісів, graceful shutdown
  config.py           # налаштування (pydantic-settings)
  parser.py           # парсинг статті та рядків черг
  messages.py         # тексти повідомлень (HTML)
  monitor.py          # цикл перевірки, дедуплікація, дайджест
  notifier.py         # надсилання з обробкою помилок Telegram
  handlers.py         # команди /start /status /queue /help
  state.py            # SQLite: meta-ключі та підписки чатів
  web.py              # /health та /
tests/                # pytest
```

## Розробка

Потрібен Python 3.11+.

```bash
pip install -r requirements.txt -r requirements-dev.txt

ruff check .           # лінт
ruff format --check .  # форматування
pytest -q              # тести
```

`requirements.txt` і `[project] dependencies` у `pyproject.toml` мають бути синхронними.

## Деплой

**Koyeb / Choreo (як зараз):**

- build: `pip install -r requirements.txt`
- run: `python bot.py`
- health check: `/health` (порт задається змінною `PORT`)
- задайте `BOT_TOKEN`, `CHAT_ID` та решту змінних у панелі.

**Docker:**

```bash
docker build -t zoe-bot .
docker run --env-file .env -p 8080:8080 zoe-bot
# або: docker compose up -d
```

## Примітки

- `zoe.com.ua` іноді віддає неповний ланцюжок TLS-сертифікатів. Бот спершу
  намагається перевіряти TLS, і лише при помилці сертифіката продовжує без
  перевірки — з попередженням у лог. Поточний стан видно в `/health` → `tls_verified`.
- Стан зберігається в SQLite (`state.db`). На хостингах з ефемерним диском
  після рестарту можливе одне повторне сповіщення про актуальний пост.
