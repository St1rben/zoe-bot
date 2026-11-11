import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractStreetVariants,
  matchAddressRow,
  matchHouse,
  matchStreet,
  parseAddressInput,
  type AlarmRow,
} from "../src/address";
import { addressHash } from "../src/alarmMessages";
import { processAlarmIngest } from "../src/alarmMonitor";
import { getChatAddresses, setChatAddresses } from "../src/alarmState";
import { handleUpdate } from "../src/commands";
import { installNetworkStub } from "./helpers";

const CHAT_ID = 777;

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

describe("address parsing & matching", () => {
  it("parseAddressInput коректно виділяє вулицю та будинок", () => {
    expect(parseAddressInput("Мирослава Симчича 21А")).toEqual({
      id: "мирослава симчича:21а",
      street: "Мирослава Симчича",
      house: "21А",
    });

    expect(parseAddressInput("вул. Павла Глазового, буд. 15Б")).toEqual({
      id: "вул:павла глазового:15б",
      street: "вул. Павла Глазового",
      house: "15Б",
    });

    expect(parseAddressInput("пров. Вогняний 69/1")).toEqual({
      id: "пров:вогняний:69/1",
      street: "пров. Вогняний",
      house: "69/1",
    });

    expect(parseAddressInput("ЛишеВулицяБезБудинку")).toBeNull();
  });

  it("matchStreet розпізнає нову назву, стару назву в дужках та скорочення за прізвищем", () => {
    const zoeStreet = "вул. Мирослава Симчича (Лізи Чайкіної)";
    expect(extractStreetVariants(zoeStreet)).toEqual({
      kind: "вул",
      variants: ["мирослава симчича", "лізи чайкіної"],
    });

    expect(matchStreet("Мирослава Симчича", zoeStreet)).toBe(true);
    expect(matchStreet("вул. Мирослава Симчича", zoeStreet)).toBe(true);
    expect(matchStreet("Лізи Чайкіної", zoeStreet)).toBe(true);
    expect(matchStreet("Симчича", zoeStreet)).toBe(true);
    expect(matchStreet("Чайкіної", zoeStreet)).toBe(true);
    // Інший тип вулиці (пров. замість вул.) не має збігатися
    expect(matchStreet("пров. Мирослава Симчича", zoeStreet)).toBe(false);
    // Однослівна назва не має хибно збігатися з першим словом двослівної вулиці
    expect(matchStreet("Зелена", "вул. Зелена Гірка")).toBe(false);
  });

  it("matchHouse враховує парність діапазонів, літери та латинські двійники", () => {
    const houses = "1-11|2-14|21А|35A|69/1|74-92А";

    // Непарний діапазон 1-11
    expect(matchHouse("1", houses)).toBe(true);
    expect(matchHouse("5", houses)).toBe(true);
    expect(matchHouse("11", houses)).toBe(true);
    // Парний діапазон 2-14
    expect(matchHouse("4", houses)).toBe(true);
    expect(matchHouse("14", houses)).toBe(true);
    // 13 і 15 не входять у 1-11|2-14
    expect(matchHouse("13", houses)).toBe(false);
    expect(matchHouse("16", houses)).toBe(false);

    // Будинки з літерами всередині діапазону без явної вказівки не збігаються (правило ЗОЕ)
    expect(matchHouse("5А", "1-11")).toBe(false);
    // Але явний токен або явна межа діапазону з літерою збігаються
    expect(matchHouse("21а", houses)).toBe(true);
    expect(matchHouse("21Б", houses)).toBe(false);
    // Латинська A в таблиці ("35A") і кирилична А у користувача ("35А")
    expect(matchHouse("35А", houses)).toBe(true);
    expect(matchHouse("69/1", houses)).toBe(true);
    expect(matchHouse("92А", houses)).toBe(true);
    expect(matchHouse("76", houses)).toBe(true);
    expect(matchHouse("77", houses)).toBe(false); // непарний у парному діапазоні 74-92А
  });

  it("matchAddressRow перевіряє населений пункт, вулицю і будинок", () => {
    const addr = parseAddressInput("Симчича 21А")!;
    const row: AlarmRow = {
      groupId: "8",
      settlement: "м.Запоріжжя",
      street: "вул. Мирослава Симчича (Лізи Чайкіної)",
      houses: "1-11|2-14|21А|21Б",
      reason: "аварійні ",
      startDate: "11.11.2026",
      startTime: "19-33",
      endDate: "12.11.2026",
      endTime: "09-00",
    };
    expect(matchAddressRow(addr, row)).toBe(true);
    expect(matchAddressRow(addr, { ...row, settlement: "с. Біленьке" })).toBe(false);
  });
});

describe("alarmMonitor full lifecycle", () => {
  const sampleRow: AlarmRow = {
    groupId: "8",
    settlement: "м.Запоріжжя",
    street: "вул. Мирослава Симчича (Лізи Чайкіної)",
    houses: "1-11|2-14|21А|21Б",
    reason: "аварійні ",
    startDate: "11.11.2026",
    startTime: "19-33",
    endDate: "12.11.2026",
    endTime: "09-00",
  };

  it("повний цикл: нове відключення → дубль без спаму → перенесення часу → відновлення", async () => {
    const net = installNetworkStub({ page: "" });
    const addr = parseAddressInput("Мирослава Симчича 21А")!;
    await setChatAddresses(env, CHAT_ID, [addr]);

    // 1. Первинний прогрев порожньої бази (silentSeed: false, щоб перевірити бойову відправку)
    await processAlarmIngest(env, {
      newPosts: [],
      restoredReplies: [],
      silentSeed: true,
    });

    // 2. Виходить новий пост про аварійне відключення (#81835)
    const step1 = await processAlarmIngest(env, {
      newPosts: [
        {
          postId: "81835",
          fileName: "Перерви_в_ел_постач_ЗМЕМ_ЦР_8_11_11_26.xlsx",
          caption: "Через пошкодження електрообладнання знеструмлено низку споживачів",
          rows: [sampleRow],
        },
      ],
    });
    expect(step1.notificationsSent).toBe(1);
    expect(net.telegramCalls).toHaveLength(1);
    expect(net.telegramCalls[0]!.text).toContain("Аварійне відключення за адресою");
    expect(net.telegramCalls[0]!.text).toContain("Мирослава Симчича, 21А");
    expect(net.telegramCalls[0]!.text).toContain("12.11.2026 о 09:00");

    // 3. Виходить кумулятивний пост (#81836) з тим самим часом відновлення — дубля НЕ має бути
    const step2 = await processAlarmIngest(env, {
      newPosts: [
        {
          postId: "81836",
          fileName: "Перерви_в_ел_постач_ЗМЕМ_ЦР_9_11_11_26.xlsx",
          caption: "Через пошкодження електрообладнання знеструмлено низку споживачів",
          rows: [sampleRow],
        },
      ],
    });
    expect(step2.notificationsSent).toBe(0);
    expect(net.telegramCalls).toHaveLength(1);

    // 4. Виходить оновлений пост (#81837), де час відновлення перенесено на 14-00
    const step3 = await processAlarmIngest(env, {
      newPosts: [
        {
          postId: "81837",
          fileName: "Перерви_в_ел_постач_ЗМЕМ_ЦР_10_11_11_26.xlsx",
          caption: "Через пошкодження електрообладнання знеструмлено низку споживачів",
          rows: [{ ...sampleRow, endTime: "14-00" }],
        },
      ],
    });
    expect(step3.notificationsSent).toBe(1);
    expect(net.telegramCalls).toHaveLength(2);
    expect(net.telegramCalls[1]!.text).toContain("Змінено час відновлення за адресою");
    expect(net.telegramCalls[1]!.text).toContain("12.11.2026 о 14:00");
    expect(net.telegramCalls[1]!.text).toContain("було: <code>09:00</code>");

    // 5. Виходить реплай "Електропостачання відновлено." на пост #81837
    const step4 = await processAlarmIngest(env, {
      restoredReplies: [
        {
          postId: "81850",
          replyToPostId: "81837",
          text: "Електропостачання відновлено.",
        },
      ],
    });
    expect(step4.notificationsSent).toBe(1);
    expect(net.telegramCalls).toHaveLength(3);
    expect(net.telegramCalls[2]!.text).toContain("Електропостачання відновлено!");
    expect(net.telegramCalls[2]!.text).toContain("Мирослава Симчича, 21А");
  });

  it("часткове відновлення: коли у файлі-відповіді адреси більше немає — сповіщає про відновлення", async () => {
    const net = installNetworkStub({ page: "" });
    const addr = parseAddressInput("Вогнетривна 5")!;
    await setChatAddresses(env, CHAT_ID, [addr]);

    await processAlarmIngest(env, { silentSeed: true });

    await processAlarmIngest(env, {
      newPosts: [
        {
          postId: "81900",
          fileName: "Перерви_в_ел_постач_ЗМЕМ_ЦР_1_11_11_26.xlsx",
          caption: "знеструмлено",
          rows: [
            {
              ...sampleRow,
              street: "вул. Вогнетривна",
              houses: "1-11",
            },
          ],
        },
      ],
    });
    expect(net.telegramCalls).toHaveLength(1);

    // Реплай з новим файлом "Електропостачання відновлено частково", де вул. Вогнетривна вже відсутня
    const partial = await processAlarmIngest(env, {
      newPosts: [
        {
          postId: "81905",
          replyToPostId: "81900",
          fileName: "Перерви_в_ел_постач_ЗМЕМ_ЦР_2_11_11_26.xlsx",
          caption: "Електропостачання відновлено частково.",
          rows: [sampleRow], // тільки Симчича, Вогнетривної немає
        },
      ],
    });
    expect(partial.notificationsSent).toBe(1);
    expect(net.telegramCalls).toHaveLength(2);
    expect(net.telegramCalls[1]!.text).toContain("Електропостачання відновлено!");
    expect(net.telegramCalls[1]!.text).toContain("Вогнетривна, 5");
  });

  it("команда /address add, перегляд і видалення через інлайн-кнопку працюють ізольовано", async () => {
    const net = installNetworkStub({ page: "" });

    await handleUpdate(env, {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: CHAT_ID },
        from: { id: 42 },
        text: "/address add Мирослава Симчича 21А",
      },
    });

    const listAfterAdd = await getChatAddresses(env, CHAT_ID);
    expect(listAfterAdd).toHaveLength(1);
    expect(net.telegramCalls).toHaveLength(2); // "Додано адресу" + меню /address
    expect(net.telegramCalls[0]!.text).toContain("Додано адресу");
    expect(net.telegramCalls[1]!.text).toContain("Активних відключень немає");

    // Натискаємо кнопку видалення
    const hash = addressHash(listAfterAdd[0]!.id);
    await handleUpdate(env, {
      update_id: 2,
      callback_query: {
        id: "cb-1",
        from: { id: 42 },
        data: `ad:${hash}`,
        message: { message_id: 11, chat: { id: CHAT_ID } },
      },
    });

    expect(await getChatAddresses(env, CHAT_ID)).toEqual([]);
  });
});
