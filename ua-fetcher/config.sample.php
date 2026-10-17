<?php
/**
 * Скопіюйте цей файл у config.php і заповніть ingest_token.
 * config.php НЕ комітиться у git (див. .gitignore).
 */
return [
    // Сторінка, доступна лише з українських мереж (перевірено з UA-вузлів).
    'source_url' => 'https://www.zoe.com.ua/outage/',

    // Наш Cloudflare Worker (маршрут прийому HTML від маячка).
    'worker_url' => 'https://zoe-outage-bot.kir245314.workers.dev/ingest',

    // Секрет INGEST_TOKEN із Cloudflare (файл %TEMP%\zoe_ingest_token.txt
    // на ПК власника бота).
    'ingest_token' => 'ВСТАВТЕ_ТОКЕН',
];
