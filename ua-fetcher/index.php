<?php
/**
 * ZOE Alert — сторінка-статус проєкту (українською).
 *
 * Показує останній відомий стан із Cloudflare-воркера (GET /health).
 * Потрібна на хостингу, щоб був «живий» сайт (умова безкоштовного тарифу
 * HyperHost — посилання на хостинг у футері).
 */
declare(strict_types=1);

const WORKER_HEALTH_URL = 'https://zoe-outage-bot.kir245314.workers.dev/health';
const BOT_URL = 'https://t.me/zp_electrikbot';
const SOURCE_URL = 'https://www.zoe.com.ua/outage/';

function fetch_health(): ?array
{
    $ch = curl_init(WORKER_HEALTH_URL);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_USERAGENT => 'ZoeAlert-UAFetcher/1.0',
    ]);
    $raw = curl_exec($ch);
    curl_close($ch);
    if (!is_string($raw)) {
        $raw = @file_get_contents(WORKER_HEALTH_URL);
    }
    if (!is_string($raw)) {
        return null;
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

function kyiv_time($ms): string
{
    if (!is_numeric($ms) || (int) $ms <= 0) {
        return '—';
    }
    $dt = (new DateTimeImmutable('@' . intdiv((int) $ms, 1000)))->setTimezone(new DateTimeZone('Europe/Kyiv'));
    return $dt->format('d.m.Y H:i');
}

$health = fetch_health();
$online = is_array($health) && (($health['status'] ?? '') === 'ok');
$lastTitle = is_array($health) && !empty($health['lastPostTitle']) ? (string) $health['lastPostTitle'] : null;
$updatedAt = kyiv_time($health['updatedAt'] ?? null);
$ingestAt = kyiv_time($health['lastIngestAt'] ?? null);
?><!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ZOE Alert — сповіщення про відключення (Запоріжжя)</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(160deg, #0f172a, #1e3a5f 60%, #2b6cb0);
    padding: 24px; color: #0f172a;
  }
  .card {
    width: 100%; max-width: 560px; background: #fff; border-radius: 16px;
    padding: 28px 28px 20px; box-shadow: 0 18px 50px rgba(0,0,0,.35);
  }
  h1 { margin: 0 0 4px; font-size: 26px; }
  .sub { margin: 0 0 18px; color: #475569; font-size: 15px; }
  .status { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; margin-bottom: 16px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #dc2626; }
  .dot.ok { background: #16a34a; }
  dl { margin: 0 0 20px; display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; font-size: 15px; }
  dt { color: #64748b; }
  dd { margin: 0; font-weight: 600; }
  .btn {
    display: inline-block; background: #2563eb; color: #fff; text-decoration: none;
    padding: 12px 20px; border-radius: 10px; font-weight: 600; font-size: 16px;
  }
  .btn:hover { background: #1d4ed8; }
  .note { margin: 18px 0 6px; color: #64748b; font-size: 13px; line-height: 1.5; }
  footer { margin-top: 18px; padding-top: 14px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #64748b; }
  footer a { color: #2563eb; }
</style>
</head>
<body>
  <main class="card">
    <h1>ZOE Alert</h1>
    <p class="sub">Сповіщення про графіки погодинних відключень електроенергії для мешканців Запорізької області.</p>

    <div class="status">
      <span class="dot<?= $online ? ' ok' : '' ?>"></span>
      <span><?= $online ? 'Сервіс працює' : 'Сервіс недоступний' ?></span>
    </div>

    <dl>
      <dt>Останній графік</dt>
      <dd><?= $lastTitle !== null ? htmlspecialchars($lastTitle, ENT_QUOTES, 'UTF-8') : 'очікуємо публікацію' ?></dd>
      <dt>Оновлено</dt>
      <dd><?= htmlspecialchars($updatedAt, ENT_QUOTES, 'UTF-8') ?></dd>
      <dt>Дані перевірено</dt>
      <dd><?= htmlspecialchars($ingestAt, ENT_QUOTES, 'UTF-8') ?></dd>
    </dl>

    <a class="btn" href="<?= BOT_URL ?>">Відкрити бота в Telegram</a>

    <p class="note">
      Бот стежить за офіційною сторінкою графіків (zoe.com.ua/outage) і надсилає
      повідомлення, коли графік для обраної черги з'являється або змінюється.
      Дані оновлюються щохвилини із мережі в Україні.
    </p>

    <footer>
      Некомерційний проєкт; не є офіційним сервісом ЗОЕ ·
      Джерело: <a href="<?= SOURCE_URL ?>" rel="noopener">zoe.com.ua</a> ·
      Розміщено на безкоштовному хостингу <a href="https://hyperhost.ua" rel="noopener">HyperHost.UA</a>
    </footer>
  </main>
</body>
</html>
