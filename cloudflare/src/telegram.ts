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
}

export interface TelegramChatMemberUpdated {
  chat: TelegramChat;
  old_chat_member?: { status?: string };
  new_chat_member?: { status?: string };
}

export function botApiUrl(env: Env, method: string): string {
  return `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
}

export function isDryRun(env: Env): boolean {
  return String(env.DRY_RUN) === "1";
}

export async function sendMessage(env: Env, chatId: number, text: string): Promise<boolean> {
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
