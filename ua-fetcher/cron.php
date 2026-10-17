<?php
/**
 * ZOE Outage Bot — «маячок» для українського хостингу.
 *
 * Раз на хвилину забирає сторінку zoe.com.ua/outage (вона доступна лише
 * з українських мереж) і надсилає її HTML у Cloudflare-воркер (POST /ingest).
 * Уся логіка — парсинг, дедуплікація, дайджест, Telegram — у воркері.
 *
 * Налаштування: config.php (копія config.sample.php) з токеном.
 * Cron:  * * * * * php /повний/шлях/cron.php
 * або зовнішній тригер (cron-job.org) на https://ваш-домен/cron.php
 */
declare(strict_types=1);

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    respond(500, 'config.php не знайдено — скопіюйте config.sample.php у config.php');
}
$config = require $configFile;

$userAgent = 'ZoeOutageBot-UAFetcher/1.0';

// 1. Забрати сторінку з zoe.com.ua (неповний TLS-ланцюжок — перевірку вимкнено)
[$html, $sourceCode, $sourceError] = http_get($config['source_url'], $userAgent);
$size = is_string($html) ? strlen($html) : 0;
if ($size < 512 || $sourceCode === 0 || $sourceCode >= 400) {
    respond(502, "fetch failed: http=$sourceCode err=$sourceError size=$size");
}

// 2. Надіслати HTML у воркер
[$response, $workerCode] = http_post($config['worker_url'], $html, $config['ingest_token']);
if ($workerCode !== 200) {
    respond(502, "worker failed: http=$workerCode resp=$response");
}

respond(200, "ok size=$size worker=$response");

function respond(int $status, string $message): void
{
    http_response_code($status);
    if (PHP_SAPI !== 'cli') {
        header('Content-Type: text/plain; charset=utf-8');
    }
    echo $message;
    exit;
}

/** @return array{0: ?string, 1: int, 2: string} [тіло, HTTP-код, помилка] */
function http_get(string $url, string $userAgent): array
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => 0,
            CURLOPT_USERAGENT => $userAgent,
            CURLOPT_ENCODING => '',
        ]);
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        return [is_string($body) ? $body : null, $code, $error];
    }

    // Фолбек без curl (якщо на хостингу вимкнено)
    $context = stream_context_create([
        'http' => ['timeout' => 30, 'user_agent' => $userAgent, 'ignore_errors' => true],
        'ssl' => ['verify_peer' => false, 'verify_peer_name' => false],
    ]);
    $body = @file_get_contents($url, false, $context);
    return [$body === false ? null : $body, code_from_headers($http_response_header ?? null), $body === false ? 'file_get_contents failed' : ''];
}

/** @return array{0: ?string, 1: int} [відповідь, HTTP-код] */
function http_post(string $url, string $body, string $token): array
{
    $headers = [
        'Content-Type: text/html; charset=utf-8',
        'X-Ingest-Token: ' . $token,
    ];

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $headers,
        ]);
        $response = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return [is_string($response) ? $response : null, $code];
    }

    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers) . "\r\n",
            'content' => $body,
            'timeout' => 30,
            'ignore_errors' => true,
        ],
    ]);
    $response = @file_get_contents($url, false, $context);
    return [$response === false ? null : $response, code_from_headers($http_response_header ?? null)];
}

/**
 * HTTP-код із масиву заголовків відповіді (фолбек без curl).
 *
 * @param array<int, string>|null $headers
 */
function code_from_headers(?array $headers): int
{
    if (!isset($headers[0]) || !preg_match('#\s(\d{3})\s#', $headers[0], $m)) {
        return 0;
    }
    return (int) $m[1];
}
