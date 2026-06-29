// POST /telegram/webhook — the bot. Drives the /newclient wizard for the
// owner and handles the approve/discard buttons on partner submissions.
//
// Auth model (capture-on-/start): until ALLOWED_CHAT_ID is set, the bot just
// echoes the sender's chat id so you can lock it. Once set, only that chat
// may use it.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  type BotState,
  clearState,
  getState,
  setState,
} from "../shared/botState";
import { clientLink, createJob, getJobById, setJobStatus } from "../shared/jobs";
import {
  allowedChatId,
  tgAnswerCallback,
  tgEditText,
  tgSend,
} from "../shared/telegram";

// Telegram retries on non-200, so we always return 200 even on internal errors.
const ok = (): APIGatewayProxyResultV2 => ({ statusCode: 200, body: "ok" });

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  let update: any;
  try {
    update = event.body ? JSON.parse(event.body) : {};
  } catch {
    return ok();
  }

  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return ok();
    }

    const msg = update.message;
    if (!msg?.chat) return ok();

    const chatId = String(msg.chat.id);
    const text: string = (msg.text ?? "").trim();

    const allowed = allowedChatId();
    if (!allowed) {
      await tgSend(
        chatId,
        `Your chat ID is <b>${chatId}</b>.\n\nSet <code>ALLOWED_CHAT_ID</code> to this value to lock the bot to you.`,
      );
      return ok();
    }
    if (chatId !== allowed) {
      await tgSend(chatId, "This bot is private.");
      return ok();
    }

    await handleOwnerMessage(chatId, text);
  } catch (err) {
    console.error("telegram webhook error", err);
  }
  return ok();
};

async function handleOwnerMessage(chatId: string, text: string): Promise<void> {
  if (text === "/start") {
    await tgSend(
      chatId,
      "👋 <b>BER Intake</b>\n\n/newclient — start a new job\n/cancel — abort the current one",
    );
    return;
  }
  if (text === "/cancel") {
    await clearState(chatId);
    await tgSend(chatId, "Cancelled.");
    return;
  }
  if (text === "/newclient") {
    await setState({ chatId, step: "name", draft: {} });
    await tgSend(chatId, "New job. What's the client's <b>name</b>?");
    return;
  }

  const state = await getState(chatId);
  if (!state) {
    await tgSend(chatId, "Use /newclient to start a new job.");
    return;
  }
  await advance(chatId, state, text);
}

async function advance(
  chatId: string,
  state: BotState,
  text: string,
): Promise<void> {
  const draft = state.draft;
  switch (state.step) {
    case "name":
      draft.name = text;
      await setState({ chatId, step: "email", draft });
      await tgSend(chatId, "Client's <b>email</b>?");
      return;
    case "email":
      draft.email = text;
      await setState({ chatId, step: "phone", draft });
      await tgSend(chatId, "Client's <b>phone</b>? (or type 'skip')");
      return;
    case "phone":
      draft.phone = /^skip$/i.test(text) ? undefined : text;
      await setState({ chatId, step: "eircode", draft });
      await tgSend(chatId, "Client's <b>eircode</b>?");
      return;
    case "eircode": {
      draft.eircode = text;
      await clearState(chatId);
      const job = await createJob({
        client: {
          name: draft.name!,
          email: draft.email!,
          phone: draft.phone,
          eircode: draft.eircode!,
        },
        source: "telegram",
        requireReview: false,
      });
      await tgSend(
        chatId,
        `✅ Job created for <b>${job.client.name}</b>.\n\nClient quote link:\n${clientLink(job.token)}`,
      );
      return;
    }
  }
}

async function handleCallback(cb: any): Promise<void> {
  const [action, jobId] = String(cb.data ?? "").split(":");
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;

  const job = jobId ? await getJobById(jobId) : undefined;
  if (!job) {
    await tgAnswerCallback(cb.id, "Job not found");
    return;
  }

  if (action === "approve") {
    await setJobStatus(jobId, "quote_sent");
    await tgAnswerCallback(cb.id, "Quote link sent");
    if (chatId && messageId) {
      await tgEditText(
        chatId,
        messageId,
        `✅ Approved — quote link for <b>${job.client.name}</b>:\n${clientLink(job.token)}`,
      );
    }
    // TODO(Phase 8): email the client the link via SES.
  } else if (action === "discard") {
    await setJobStatus(jobId, "discarded");
    await tgAnswerCallback(cb.id, "Discarded");
    if (chatId && messageId) {
      await tgEditText(
        chatId,
        messageId,
        `🗑 Discarded job for ${job.client.name}.`,
      );
    }
  } else {
    await tgAnswerCallback(cb.id);
  }
}
