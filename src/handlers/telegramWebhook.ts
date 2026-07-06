// POST /telegram/webhook — the bot. Drives the /newclient wizard for the
// owner and handles the approve/discard buttons on partner submissions.
//
// Auth model (capture-on-/start): until ALLOWED_CHAT_ID is set, the bot just
// echoes the sender's chat id so you can lock it. Once set, only that chat
// may use it.

import { timingSafeEqual } from "node:crypto";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  type BotState,
  clearState,
  getState,
  markUpdateProcessed,
  setState,
} from "../shared/botState";
import { createBookedEvent } from "../shared/calendar";
import { escapeHtml } from "../shared/html";
import { computeQuotePricing } from "../shared/pricing";
import {
  clientLink,
  createJob,
  getJobById,
  seedBerFromEircode,
  setAgreedPrice,
  setBooking,
  setJobStatus,
  setQuote,
} from "../shared/jobs";
import {
  sendBookingPrefilledEmail,
  sendQuoteRequestEmail,
} from "../shared/notify";
import {
  allowedChatId,
  tgAnswerCallback,
  tgEditText,
  tgSend,
} from "../shared/telegram";
import { hydrateSecrets } from "../shared/secrets";

// Telegram retries on non-200, so we always return 200 even on internal errors.
const ok = (): APIGatewayProxyResultV2 => ({ statusCode: 200, body: "ok" });
const unauthorized = (): APIGatewayProxyResultV2 => ({
  statusCode: 401,
  body: "unauthorized",
});

// Constant-time equality; false if either side is empty (fail closed).
function secretsMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  // Authenticate: Telegram sends the configured secret_token on every request as
  // this header. Reject anything else (fail closed if the env var is unset).
  if (
    !secretsMatch(
      event.headers?.["x-telegram-bot-api-secret-token"],
      process.env.TELEGRAM_WEBHOOK_SECRET,
    )
  ) {
    console.warn("telegram webhook rejected — missing/invalid secret token");
    return unauthorized();
  }

  let update: any;
  try {
    update = event.body ? JSON.parse(event.body) : {};
  } catch {
    return ok();
  }

  try {
    // De-duplicate: Telegram retries a webhook it thinks failed/timed out.
    if (typeof update.update_id === "number") {
      if (!(await markUpdateProcessed(update.update_id))) return ok();
    }

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

const SIZE_MAP: Record<string, string> = {
  apt: "apartment",
  apartment: "apartment",
  lt200: "small-house",
  "<200": "small-house",
  small: "small-house",
  mt200: "large-house",
  ">200": "large-house",
  large: "large-house",
};

function sizeToPropertyType(size: string): string | undefined {
  return SIZE_MAP[size.trim().toLowerCase()];
}

/** Parse "YYYY-MM-DD HH:MM" into naive start + end (+1h) strings. */
function parseDateTime(
  input: string,
): { startNaive: string; endNaive: string } | undefined {
  const m = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m;
  const hour = Number(h);
  const min = Number(mi);
  if (hour > 23 || min > 59) return undefined;
  const p = (n: number) => String(n).padStart(2, "0");
  const startNaive = `${y}-${mo}-${d}T${p(hour)}:${p(min)}:00`;
  const endMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, min) + 3600000;
  const e = new Date(endMs);
  const endNaive = `${e.getUTCFullYear()}-${p(e.getUTCMonth() + 1)}-${p(e.getUTCDate())}T${p(e.getUTCHours())}:${p(e.getUTCMinutes())}:00`;
  return { startNaive, endNaive };
}

async function handleOwnerMessage(chatId: string, text: string): Promise<void> {
  if (text === "/start") {
    await tgSend(
      chatId,
      "👋 <b>BER Intake</b>\n\n" +
        "/newquote — client gets a link to choose property type, date & price themselves\n" +
        "/newclient — pre-agreed: you set size, date/time & (optional) price\n" +
        "/cancel — abort the current one",
    );
    return;
  }
  if (text === "/cancel") {
    await clearState(chatId);
    await tgSend(chatId, "Cancelled.");
    return;
  }
  if (text === "/newquote") {
    await setState({ chatId, flow: "quote", step: "name", draft: {} });
    await tgSend(chatId, "New quote. What's the client's <b>name</b>?");
    return;
  }
  if (text === "/newclient") {
    await setState({ chatId, flow: "client", step: "name", draft: {} });
    await tgSend(chatId, "New pre-agreed booking. What's the client's <b>name</b>? (or type 'skip' if you don't know it yet — the client fills it in on the form)");
    return;
  }

  const state = await getState(chatId);
  if (!state) {
    await tgSend(chatId, "Use /newquote or /newclient to start.");
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
      draft.name = /^skip$/i.test(text) ? undefined : text;
      await setState({ chatId, flow: state.flow, step: "email", draft });
      await tgSend(chatId, "Client's <b>email</b>?");
      return;
    case "email":
      draft.email = text;
      await setState({ chatId, flow: state.flow, step: "phone", draft });
      await tgSend(chatId, "Client's <b>phone</b>? (or type 'skip')");
      return;
    case "phone":
      draft.phone = /^skip$/i.test(text) ? undefined : text;
      await setState({ chatId, flow: state.flow, step: "eircode", draft });
      await tgSend(chatId, "Client's <b>eircode</b>?");
      return;
    case "eircode": {
      draft.eircode = text;
      if (state.flow === "quote") {
        await clearState(chatId);
        const job = await createJob({
          client: clientOf(draft),
          source: "telegram",
          requireReview: false,
        });
        await sendQuoteRequestEmail(job);
        await tgSend(
          chatId,
          `✅ Quote created for <b>${escapeHtml(job.client.name)}</b> — quote email sent to ${escapeHtml(job.client.email)}.\n\nClient link:\n${clientLink(job.token)}`,
        );
        return;
      }
      // client flow — gather the pre-agreed details next
      await setState({ chatId, flow: state.flow, step: "size", draft });
      await tgSend(
        chatId,
        "Property <b>size</b>? Reply <code>apt</code>, <code>lt200</code> (house &lt;200m²), or <code>mt200</code> (house &gt;200m²).",
      );
      return;
    }
    case "size": {
      const pt = sizeToPropertyType(text);
      if (!pt) {
        await tgSend(chatId, "Please reply <code>apt</code>, <code>lt200</code>, or <code>mt200</code>.");
        return;
      }
      draft.size = text.trim().toLowerCase();
      await setState({ chatId, flow: state.flow, step: "datetime", draft });
      await tgSend(
        chatId,
        "Appointment <b>date & time</b>? Format <code>YYYY-MM-DD HH:MM</code> (24h, Irish time). E.g. <code>2026-07-10 14:00</code>",
      );
      return;
    }
    case "datetime": {
      if (!parseDateTime(text)) {
        await tgSend(chatId, "Couldn't read that. Use <code>YYYY-MM-DD HH:MM</code>, e.g. <code>2026-07-10 14:00</code>");
        return;
      }
      draft.datetime = text.trim();
      await setState({ chatId, flow: state.flow, step: "price", draft });
      await tgSend(chatId, "Agreed <b>price</b> in €? (or type 'skip' to use the standard zone price)");
      return;
    }
    case "price": {
      if (!/^skip$/i.test(text)) {
        const n = Number(text.replace(/[€,\s]/g, ""));
        if (!Number.isFinite(n) || n < 0) {
          await tgSend(chatId, "Please enter a number (e.g. 280) or 'skip'.");
          return;
        }
        draft.price = n;
      }
      await clearState(chatId);
      await createPreAgreedJob(chatId, draft);
      return;
    }
  }
}

function clientOf(draft: {
  name?: string;
  email?: string;
  phone?: string;
  eircode?: string;
}) {
  return {
    // Name may be skipped (unknown at booking time); the client fills it in on
    // the booking form, which backfills the record via setDetails.
    name: draft.name ?? "",
    email: draft.email!,
    phone: draft.phone,
    eircode: draft.eircode!,
  };
}

async function createPreAgreedJob(
  chatId: string,
  draft: {
    name?: string;
    email?: string;
    phone?: string;
    eircode?: string;
    size?: string;
    datetime?: string;
    price?: number;
  },
): Promise<void> {
  const propertyType = sizeToPropertyType(draft.size!)!;
  const dt = parseDateTime(draft.datetime!)!;

  // An explicitly entered price is a trusted override; skipping it falls back
  // to the zone price (for display only — resolveJobPrice recomputes it).
  const agreed = draft.price;
  let price = agreed;
  if (price == null) {
    const computed = await computeQuotePricing(draft.eircode!);
    if (computed) price = (computed.prices as any)[propertyType];
  }

  const job = await createJob({
    client: clientOf(draft),
    source: "telegram",
    requireReview: false,
  });
  await setQuote(job.jobId, {
    propertyType,
    price,
    quotedAt: new Date().toISOString(),
  });
  if (agreed != null) await setAgreedPrice(job.jobId, agreed);

  const summary = `BOOKED: ${job.client.name} | ${job.client.eircode} | ${job.client.email}`;
  let bookingLine = "";
  try {
    const ev = await createBookedEvent(summary, dt.startNaive, dt.endNaive);
    await setBooking(job.jobId, {
      eventId: ev.id,
      start: ev.start,
      end: ev.end,
      bookedAt: new Date().toISOString(),
    });
    bookingLine = `\n📅 ${ev.start}`;
    // Seed the BER for the tablet (address, satellite image, property type) —
    // the web booking flow does this in book.ts; the Telegram flow must too, or
    // the job reaches the assessor's tablet with no name and no site image.
    // Best-effort: never fail the booking over the seed.
    try {
      await seedBerFromEircode(job, { propertyType });
    } catch (err) {
      console.error(`berSeed generation failed for ${job.jobId}`, err);
    }
  } catch (err) {
    console.error("failed to create calendar event", err);
    bookingLine = "\n⚠️ Couldn't add to calendar — add it manually.";
  }

  const full = (await getJobById(job.jobId)) ?? job;
  await sendBookingPrefilledEmail(full);

  await tgSend(
    chatId,
    `✅ Booking created for <b>${escapeHtml(job.client.name || `(name TBC) ${job.client.eircode}`)}</b> (${propertyType}${price != null ? `, €${price}` : ""}).${bookingLine}\n` +
      `Email sent to ${escapeHtml(job.client.email)}.\n\nClient link:\n${clientLink(job.token)}`,
  );
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
    await sendQuoteRequestEmail(job);
    await tgAnswerCallback(cb.id, "Quote email sent");
    if (chatId && messageId) {
      await tgEditText(
        chatId,
        messageId,
        `✅ Approved — quote email sent to <b>${escapeHtml(job.client.name)}</b> (${escapeHtml(job.client.email)}).\n${clientLink(job.token)}`,
      );
    }
  } else if (action === "discard") {
    await setJobStatus(jobId, "discarded");
    await tgAnswerCallback(cb.id, "Discarded");
    if (chatId && messageId) {
      await tgEditText(
        chatId,
        messageId,
        `🗑 Discarded job for ${escapeHtml(job.client.name)}.`,
      );
    }
  } else {
    await tgAnswerCallback(cb.id);
  }
}
