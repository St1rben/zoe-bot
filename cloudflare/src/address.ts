/**
 * Парсинг, нормалізація та зіставлення адрес для планових і аварійних
 * відключень із файлів .xlsx каналу t.me/zoe_alarm (м. Запоріжжя, ЗМЕМ).
 *
 * Повністю ізольований модуль — не зачіпає логіку ГПВ (parser.ts / monitor.ts).
 */

export const MAX_ADDRESSES_PER_CHAT = 10;
export const DEFAULT_SETTLEMENT = "м. Запоріжжя";

export interface TrackedAddress {
  /** Стабільний ключ адреси: "<normStreet>:<normHouse>" */
  id: string;
  /** Назва вулиці у зручному для відображення вигляді */
  street: string;
  /** Номер будинку у зручному для відображення вигляді */
  house: string;
}

export interface AlarmRow {
  groupId: string;
  settlement: string;
  street: string;
  houses: string;
  reason: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

type StreetKind = "вул" | "пров" | "просп" | "бул" | "шосе" | "пл" | "наб" | "туп";

const STREET_KIND_PATTERNS: ReadonlyArray<readonly [RegExp, StreetKind]> = [
  [/^(?:вул\.?|вулиця|ул\.?|улица)(?=$|[\s.,])/i, "вул"],
  [/^(?:пров\.?|провулок|пер\.?|переулок)(?=$|[\s.,])/i, "пров"],
  [/^(?:пр-?т\.?|просп\.?|проспект|пр\.)(?=$|[\s.,])/i, "просп"],
  [/^(?:бул\.?|бульв\.?|бульвар|б-р\.?)(?=$|[\s.,])/i, "бул"],
  [/^(?:шосе|шоссе|ш\.)(?=$|[\s.,])/i, "шосе"],
  [/^(?:майдан|пл\.?|площа|площадь)(?=$|[\s.,])/i, "пл"],
  [/^(?:наб\.?|набережна|набережная)(?=$|[\s.,])/i, "наб"],
  [/^(?:туп\.?|тупик)(?=$|[\s.,])/i, "туп"],
];

const STRIP_STREET_WORDS_RE =
  /(?:^|[\s.,;()\-])(?:вулиця|вул|улица|ул|провулок|пров|переулок|пер|проспект|просп|пр-т|пр|бульвар|бульв|бул|б-р|шосе|шоссе|майдан|площа|площадь|пл|набережна|набережная|наб|тупик|туп)\.?(?=$|[\s.,;()\-])/gi;

/** Латинські літери-двійники у номерах будинків → українська кирилиця. */
const HOMOGLYPH_MAP: Readonly<Record<string, string>> = {
  a: "а",
  b: "в",
  c: "с",
  e: "е",
  h: "н",
  i: "і",
  k: "к",
  m: "м",
  o: "о",
  p: "р",
  t: "т",
  x: "х",
};

/** Нормалізує номер будинку: прибирає «буд.», примітки в дужках, пробіли, зводить латиницю до кирилиці. */
export function normalizeHouse(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/\([^)]*\)/g, "")
    .replace(/^(?:буд(?:инок|\.)?|д(?:ом|\.)?|№)\s*/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();

  let out = "";
  for (const ch of cleaned) {
    out += HOMOGLYPH_MAP[ch] ?? ch;
  }
  return out;
}

/** Форматує номер будинку для красивого виводу (верхній регістр літер). */
export function formatHouseDisplay(raw: string): string {
  const norm = normalizeHouse(raw);
  return norm.toUpperCase();
}

/** Визначає тип вулиці (вул / пров / просп / шосе тощо), якщо він явно вказаний. */
export function detectStreetKind(raw: string): StreetKind | null {
  const trimmed = raw.trim();
  for (const [re, kind] of STREET_KIND_PATTERNS) {
    if (re.test(trimmed)) return kind;
  }
  return null;
}

/** Очищує одну назву вулиці (без дужок) для порівняння. */
export function normalizeStreetName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’`ʼ"]/g, "")
    .replace(/ё/g, "е")
    .replace(STRIP_STREET_WORDS_RE, " ")
    .replace(/[.,;:()\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Розбирає назву вулиці з таблиці ЗОЕ на основну та стару назву в дужках.
 * Наприклад: "вул. Мирослава Симчича (Лізи Чайкіної)" → ["мирослава симчича", "лізи чайкіної"]
 */
export function extractStreetVariants(raw: string): {
  kind: StreetKind | null;
  variants: string[];
} {
  const kind = detectStreetKind(raw);
  const variants: string[] = [];

  const parenRe = /\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = parenRe.exec(raw)) !== null) {
    const inside = normalizeStreetName(match[1] ?? "");
    if (inside.length > 0 && !variants.includes(inside)) {
      variants.push(inside);
    }
  }

  const outside = normalizeStreetName(raw.replace(/\([^)]*\)/g, " "));
  if (outside.length > 0 && !variants.includes(outside)) {
    variants.unshift(outside);
  }

  return { kind, variants };
}

/**
 * Перевіряє, чи збігається вулиця користувача з рядком вулиці в таблиці ЗОЕ.
 * Підтримує:
 * - повний збіг за новою або старою назвою в дужках
 * - скорочення за прізвищем для двослівних назв ("Симчича" → "Мирослава Симчича")
 * - переставлені слова ("Симчича Мирослава" → "Мирослава Симчича")
 */
export function matchStreet(userStreetRaw: string, tableStreetRaw: string): boolean {
  const userParsed = extractStreetVariants(userStreetRaw);
  const tableParsed = extractStreetVariants(tableStreetRaw);

  if (
    userParsed.kind !== null &&
    tableParsed.kind !== null &&
    userParsed.kind !== tableParsed.kind
  ) {
    return false;
  }

  if (userParsed.variants.length === 0 || tableParsed.variants.length === 0) {
    return false;
  }

  for (const u of userParsed.variants) {
    const uWords = u.split(" ").filter(Boolean);
    for (const t of tableParsed.variants) {
      if (u === t) return true;

      const tWords = t.split(" ").filter(Boolean);
      // Якщо користувач ввів лише прізвище (останнє слово з 2-слівної назви, >= 4 символи)
      if (uWords.length === 1 && uWords[0]!.length >= 4 && tWords.length === 2) {
        if (uWords[0] === tWords[1]) return true;
      }
      // Переставлені місцями ім'я та прізвище
      if (
        uWords.length === 2 &&
        tWords.length === 2 &&
        uWords[0] === tWords[1] &&
        uWords[1] === tWords[0]
      ) {
        return true;
      }
    }
  }

  return false;
}

const HOUSE_PARTS_RE = /^(\d+)([а-яіїєґa-z/]*)$/i;
const HOUSE_RANGE_RE = /^(\d+)([а-яіїєґa-z]*)\s*-\s*(\d+)([а-яіїєґa-z]*)$/i;

/**
 * Перевіряє, чи входить будинок користувача у список будинків клітинки «Буд»
 * (напр. "1-11|2-14|13-19|21А|21Б|69/1|74-92А").
 *
 * Правила ЗОЕ:
 * 1) Точний токен ("21А", "69/1", "16") — точний збіг нормалізованого номера.
 * 2) Діапазон "A-B":
 *    - якщо A і B однієї парності (обидва парні або обидва непарні) — збігаються
 *      лише будинки тієї ж парності (сторона вулиці);
 *    - якщо різної парності ("1-10") — усі цілі номери від A до B;
 *    - будинки з літерами ("33А") у ЗОЕ вказуються окремо від цілого діапазону
 *      ("25-37|33А"), тому всередині діапазону матчимо лише цілі номери без літер,
 *      а також самі межі діапазону, якщо вони містять літеру (напр. "92А" у "74-92А").
 */
export function matchHouse(userHouseRaw: string, tableHousesRaw: string): boolean {
  const userNorm = normalizeHouse(userHouseRaw);
  if (!userNorm) return false;

  const userMatch = HOUSE_PARTS_RE.exec(userNorm);
  const userNum = userMatch !== null ? Number(userMatch[1]) : null;
  const userSuffix = userMatch !== null ? (userMatch[2] ?? "") : null;

  const tokens = tableHousesRaw
    .split(/[|,;]/)
    .map((t) => t.trim())
    .filter(Boolean);

  for (const rawToken of tokens) {
    const tokenNorm = normalizeHouse(rawToken);
    if (!tokenNorm) continue;

    // 1. Точний збіг (включно з корпусами/літерами/дробами: 21а, 69/1)
    if (tokenNorm === userNorm) return true;

    // 2. Перевірка діапазону A-B
    const rangeMatch = HOUSE_RANGE_RE.exec(tokenNorm);
    if (rangeMatch !== null) {
      const startNum = Number(rangeMatch[1]);
      const startSuffix = rangeMatch[2] ?? "";
      const endNum = Number(rangeMatch[3]);
      const endSuffix = rangeMatch[4] ?? "";

      // Якщо будинок користувача збігається з явною літерною межею діапазону (напр. 92А у 74-92А)
      if (`${startNum}${startSuffix}` === userNorm || `${endNum}${endSuffix}` === userNorm) {
        return true;
      }

      // Числове входження у діапазон — лише для будинків без літер/дробів
      if (userNum !== null && userSuffix === "" && startNum <= endNum) {
        if (userNum >= startNum && userNum <= endNum) {
          const sameSideParity = startNum % 2 === endNum % 2;
          if (!sameSideParity || userNum % 2 === startNum % 2) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/** Перевіряє, чи стосується рядок таблиці ЗОЕ (м. Запоріжжя) відстежуваної адреси. */
export function matchAddressRow(address: TrackedAddress, row: AlarmRow): boolean {
  if (row.settlement) {
    const normSettlement = row.settlement.toLowerCase().replace(/\s+/g, "");
    if (!normSettlement.includes("запоріжжя")) return false;
  }
  return matchStreet(address.street, row.street) && matchHouse(address.house, row.houses);
}

/**
 * Розбирає аргумент команди `/address add <вулиця> <будинок>`.
 * Приклади:
 *   "Мирослава Симчича 21А" → { street: "Мирослава Симчича", house: "21А" }
 *   "вул. Соборний, 150"   → { street: "вул. Соборний", house: "150" }
 *   "пров. Вогняний 69/1"  → { street: "пров. Вогняний", house: "69/1" }
 */
export function parseAddressInput(raw: string): TrackedAddress | null {
  // Склеюємо пробіл між цифрою та одиночною літерою корпусу в кінці ("21 А" -> "21А")
  const cleaned = raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(\d)\s+([а-яіїєґa-z])$/iu, "$1$2");
  if (!cleaned) return null;

  // Шукаємо останній токен як номер будинку (напр. "21А", "69/1", "буд. 5")
  const match =
    /^(.*?)(?:[,\s]+(?:буд(?:инок|\.)?|д(?:ом|\.)?|№)?\s*)(\d+[а-яіїєґa-zA-Z0-9/-]*)$/i.exec(
      cleaned,
    );
  if (match === null) return null;

  const streetRaw = (match[1] ?? "").replace(/[,.\s]+$/, "").trim();
  const houseRaw = (match[2] ?? "").trim();

  const normStreet = normalizeStreetName(streetRaw);
  const normHouse = normalizeHouse(houseRaw);
  if (normStreet.length < 2 || !normHouse || !/^\d/.test(normHouse)) {
    return null;
  }

  const kind = detectStreetKind(streetRaw);
  const id = `${kind ? kind + ":" : ""}${normStreet}:${normHouse}`;

  return {
    id,
    street: streetRaw,
    house: formatHouseDisplay(houseRaw),
  };
}
