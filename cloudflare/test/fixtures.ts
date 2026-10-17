/** HTML-фікстури — ті самі, що й у Python-тестах (tests/conftest.py). */

export const CONSUMER_ARTICLE_HTML = `
<article id="post-1234">
  <h2>Графік відключень на 17 жовтня</h2>
  <div class="content">
    <p>Сьогодні будуть застосовані графіки погодинних відключень:</p>
    1.1: 08:00 - 12:00
    5.1: 08:00 - 10:00, 16:00 - 20:00
    5.2: 10:00 - 12:00
    <p>Дякуємо за розуміння</p>
  </div>
</article>
`;

export const BUSINESS_ARTICLE_HTML = `
<article id="post-2000">
  <h2>ДО УВАГИ ПРОМИСЛОВОСТІ ТА БІЗНЕСУ 18 ЖОВТНЯ</h2>
  <div class="content">
    <p>18 жовтня для промисловості та бізнесу діють графіки обмеження потужності.</p>
    <p>Дані обмеження НЕ СТОСУЮТЬСЯ НАСЕЛЕННЯ.</p>
  </div>
</article>
`;

export const SAMPLE_HTML = `<html><body>${CONSUMER_ARTICLE_HTML}</body></html>`;

export const MIXED_PAGE_HTML = `<html><body>${BUSINESS_ARTICLE_HTML}${CONSUMER_ARTICLE_HTML}</body></html>`;

export const NO_SCHEDULE_HTML = `
<html><body>
<article id="post-9999">
  <h2>УВАГА! Відключення</h2>
  <div class="content">
    <p>Графіки погодинних відключень НЕ ЗАПЛАНОВАНІ.</p>
  </div>
</article>
</body></html>
`;

export const NO_ARTICLE_HTML = "<html><body><div>Нічого немає</div></body></html>";

/** Той самий пост, але з іншим часом для 5.1 (імітація оновлення графіка). */
export const SAMPLE_HTML_UPDATED = SAMPLE_HTML.replace(
  "5.1: 08:00 - 10:00, 16:00 - 20:00",
  "5.1: 12:00 - 14:00",
);
