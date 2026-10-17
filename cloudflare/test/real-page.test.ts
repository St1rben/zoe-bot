/**
 * Інтеграційний тест на знімку справжньої сторінки zoe.com.ua/outage.
 *
 * Саме ця розмітка (22 статті, `<br />`, тире «–», текст у вкладеному <p>)
 * валила HTMLRewriter помилкою «Parser error: No end tag» — тепер вона
 * назавжди зафіксована як регресійна фікстура.
 */
import raw from "./real-page.html?raw";
import { describe, expect, it } from "vitest";
import { isBusinessPost, parsePage } from "../src/parser";

describe("жива сторінка zoe (знімок)", () => {
  it("парситься повністю", async () => {
    const posts = await parsePage(raw);
    // 22 теги <article>, але два з них без id — ігноруються (як у Python-версії)
    expect(posts).toHaveLength(20);
    expect(posts[0]!.id).toBe("post-392435");
    expect(isBusinessPost(posts[0]!)).toBe(true);
  });

  it("пост для населення розпізнано, черги розібрані", async () => {
    const posts = await parsePage(raw);
    const post = posts.find((candidate) => !isBusinessPost(candidate));
    expect(post).toBeDefined();
    expect(post!.id).toBe("post-392434");
    expect(post!.title).toContain("ОНОВЛЕНО ГПВ НА 17 ЖОВТНЯ");
    expect(post!.queues["5.1"]).toBe("16:30 - 20:30");
    expect(post!.queues["1.1"]).toBe("10:30 - 13:30, 17:00 - 18:30");
  });
});
