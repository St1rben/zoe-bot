/** Мінімальний клієнт Telegram Bot API (лише те, що потрібно боту). */

export interface TelegramChat {
  id: number;
  type?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
  from?: { id: number; first_name?: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  /** Зміна членства бота в чаті (додали/видалили/змінили права). */
  my_chat_member?: TelegramChatMemberUpdated;
  /** Натискання інлайн-кнопки (вибір черг). */
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramChatMemberUpdated {
  chat: TelegramChat;
  old_chat_member?: { status?: string };
  new_chat_member?: { status?: string };
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name?: string };
  /** callback_data кнопки, напр. «qt:5.1» */
  data?: string;
  /** Повідомлення, з якого натиснули кнопку (для editMessageText). */
  message?: { message_id: number; chat: TelegramChat };
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export function botApiUrl(env: Env, method: string): string {
  return `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
}

export function isDryRun(env: Env): boolean {
  return String(env.DRY_RUN) === "1";
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<boolean> {
  if (isDryRun(env)) {
    console.log(`[DRY-RUN] → chat ${chatId}:\n${text}`);
    return true;
  }
  try {
    const response = await fetch(botApiUrl(env, "sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`Telegram sendMessage → ${response.status}: ${body}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Telegram sendMessage failed:", error);
    return false;
  }
}

/** Оновлює текст і клавіатуру вже надісланого повідомлення (вибір черг). */
export async function editMessageText(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<boolean> {
  if (isDryRun(env)) {
    console.log(`[DRY-RUN] edit message ${messageId} → chat ${chatId}:\n${text}`);
    return true;
  }
  try {
    const response = await fetch(botApiUrl(env, "editMessageText"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`Telegram editMessageText → ${response.status}: ${body}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Telegram editMessageText failed:", error);
    return false;
  }
}

/** Закриває «годинник» на кнопці та показує короткий тост користувачу. */
export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  if (isDryRun(env)) {
    console.log(`[DRY-RUN] answerCallbackQuery ${callbackQueryId}: ${text ?? ""}`);
    return;
  }
  try {
    const response = await fetch(botApiUrl(env, "answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(text !== undefined ? { text } : {}),
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`Telegram answerCallbackQuery → ${response.status}: ${body}`);
    }
  } catch (error) {
    console.error("Telegram answerCallbackQuery failed:", error);
  }
}
