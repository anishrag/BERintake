// Thin Telegram Bot API wrapper (uses the global fetch in Node 22).

const api = (path: string) =>
  `https://api.telegram.org/bot${botToken()}/${path}`;

function botToken(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return t;
}

async function call(path: string, payload: unknown): Promise<void> {
  const res = await fetch(api(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`telegram ${path} failed: ${res.status} ${await res.text()}`);
  }
}

export async function tgSend(
  chatId: number | string,
  text: string,
  replyMarkup?: unknown,
): Promise<void> {
  await call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
}

export async function tgEditText(
  chatId: number | string,
  messageId: number,
  text: string,
): Promise<void> {
  await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  });
}

export async function tgAnswerCallback(
  callbackId: string,
  text?: string,
): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: callbackId, text });
}

/** The single chat allowed to drive the bot, or undefined if not yet locked. */
export function allowedChatId(): string | undefined {
  const v = process.env.ALLOWED_CHAT_ID;
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Notify the owner (e.g. a partner submission awaiting review). No-op if unlocked. */
export async function notifyOwner(
  text: string,
  replyMarkup?: unknown,
): Promise<void> {
  const id = allowedChatId();
  if (!id) return;
  await tgSend(id, text, replyMarkup);
}
