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
import {
  approveBooking,
  rejectBooking,
} from "../shared/confirmation";
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
  sendAuctioneeraBookingEmail,
  sendBookingPrefilledEmail,
  sendQuoteRequestEmail,
  sendSolarBookingEmail,
  sendSolarPrefilledEmail,
} from "../shared/notify";
import { solarPartner, solarPricesConfigured } from "../shared/solarPartner";
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

// Inline "Skip" button for optional questions. The step is baked into the
// callback data so a stale button (from an earlier question) can't skip the
// wrong step. Pressing it is equivalent to typing "skip", which still works.
const skipKeyboard = (step: BotState["step"]) => ({
  inline_keyboard: [[{ text: "⏭ Skip", callback_data: `skip:${step}` }]],
});

// --- date & time picker (inline keyboards for the "datetime" step) ---------
// Telegram has no native picker, so the calendar is an inline keyboard:
// header with ‹ › month navigation (cal:YYYY-MM), a weekday row, and day
// buttons (day:YYYY-MM-DD). Picking a day swaps the message to a grid of
// half-hour slots (tm:YYYY-MM-DDTHH:MM). Typing YYYY-MM-DD HH:MM still works.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const pad2 = (n: number) => String(n).padStart(2, "0");
const cbBtn = (text: string, data: string) => ({ text, callback_data: data });
const NOOP_BTN = cbBtn(" ", "noop");

function calendarKeyboard(year: number, month: number) {
  // month is 1–12; the grid is Monday-first.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const prev = month === 1 ? `${year - 1}-12` : `${year}-${pad2(month - 1)}`;
  const next = month === 12 ? `${year + 1}-01` : `${year}-${pad2(month + 1)}`;
  const rows: (typeof NOOP_BTN)[][] = [
    [cbBtn("‹", `cal:${prev}`), cbBtn(`${MONTH_NAMES[month - 1]} ${year}`, "noop"), cbBtn("›", `cal:${next}`)],
    ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => cbBtn(d, "noop")),
  ];
  let row = Array.from({ length: lead }, () => NOOP_BTN);
  for (let d = 1; d <= daysInMonth; d++) {
    row.push(cbBtn(String(d), `day:${year}-${pad2(month)}-${pad2(d)}`));
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) {
    while (row.length < 7) row.push(NOOP_BTN);
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function currentMonthCalendar() {
  const now = new Date();
  return calendarKeyboard(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

function timeKeyboard(date: string) {
  const rows: (typeof NOOP_BTN)[][] = [];
  let row: (typeof NOOP_BTN)[] = [];
  for (let h = 8; h <= 20; h++) {
    for (const m of h === 20 ? [0] : [0, 30]) {
      row.push(cbBtn(`${pad2(h)}:${pad2(m)}`, `tm:${date}T${pad2(h)}:${pad2(m)}`));
      if (row.length === 4) {
        rows.push(row);
        row = [];
      }
    }
  }
  if (row.length) rows.push(row);
  rows.push([cbBtn("‹ back to calendar", `cal:${date.slice(0, 7)}`)]);
  return { inline_keyboard: rows };
}

const DATETIME_PROMPT =
  "Appointment <b>date & time</b>? Pick a day below, or type <code>YYYY-MM-DD HH:MM</code> (24h, Irish time).";

// Google returns event times as UTC ("…Z") — always show the owner Irish time.
function fmtIrish(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-IE", {
      timeZone: "Europe/Dublin",
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
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

const COMMAND_LIST =
  "/newquote — client gets a link to choose property type, date & price themselves\n" +
  "/newclient — pre-agreed: you set size, date/time & (optional) price\n" +
  "/newsolar — solar-partner job: client picks size & date, the partner is invoiced\n" +
  "/newsolar_arranged — solar-partner job with a pre-agreed date/time; client fills the rest\n" +
  "/newauctioneera — client already paid Auctioneera: just email + price, commission deducted on the invoice\n" +
  "/cancel — abort the current one";

async function handleOwnerMessage(chatId: string, text: string): Promise<void> {
  if (text === "/start") {
    await tgSend(chatId, `👋 <b>BER Intake</b>\n\n${COMMAND_LIST}`);
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
    await tgSend(
      chatId,
      "New pre-agreed booking. What's the client's <b>name</b>? (skip if you don't know it yet — the client fills it in on the form)",
      skipKeyboard("name"),
    );
    return;
  }
  if (text === "/newsolar") {
    await setState({ chatId, flow: "solar", step: "name", draft: {} });
    await tgSend(
      chatId,
      `New solar-partner job — billed to <b>${escapeHtml(solarPartner().name)}</b>, the client picks their own slot. What's the client's <b>name</b>? (skip if you don't know it yet — the client fills it in on the form)`,
      skipKeyboard("name"),
    );
    return;
  }
  if (text === "/newsolar_arranged") {
    await setState({ chatId, flow: "solar_arranged", step: "name", draft: {} });
    await tgSend(
      chatId,
      `New pre-agreed solar-partner booking — billed to <b>${escapeHtml(solarPartner().name)}</b>, you set the slot. What's the client's <b>name</b>? (skip if you don't know it yet — the client fills it in on the form)`,
      skipKeyboard("name"),
    );
    return;
  }
  if (text === "/newauctioneera") {
    await setState({ chatId, flow: "auctioneera", step: "name", draft: {} });
    await tgSend(
      chatId,
      "New Auctioneera job (client already paid them). What's the client's <b>name</b>? (skip if you don't know it yet — the client fills it in on the form)",
      skipKeyboard("name"),
    );
    return;
  }

  const state = await getState(chatId);

  // An unrecognised /command is never a valid wizard answer — prompt with the
  // command list instead of swallowing it into the current step. A running
  // wizard survives (just answer its question, or /cancel).
  if (text.startsWith("/")) {
    await tgSend(
      chatId,
      `🤔 I don't know <code>${escapeHtml(text)}</code>. Commands:\n\n${COMMAND_LIST}` +
        (state ? "\n\n(You're mid-wizard — answer its last question, or /cancel.)" : ""),
    );
    return;
  }

  if (!state) {
    await tgSend(
      chatId,
      `Nothing in progress — start with one of:\n\n${COMMAND_LIST}`,
    );
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

  // Confirming an out-of-zone booking: the owner types the agreed price, which
  // both prices the job (agreedPrice overrides the €400 flat rate) and approves
  // the confirmation gate.
  if (state.flow === "confirm_price") {
    const n = Number(text.replace(/[€,\s]/g, ""));
    if (!Number.isFinite(n) || n <= 0) {
      await tgSend(chatId, "Please enter the agreed price as a number, e.g. <code>450</code>.");
      return;
    }
    await clearState(chatId);
    const job = draft.jobId ? await getJobById(draft.jobId) : undefined;
    if (!job) {
      await tgSend(chatId, "That booking no longer exists.");
      return;
    }
    await setAgreedPrice(job.jobId, n);
    // Approve with the price applied so the client's invoice uses it.
    await approveBooking({ ...job, agreedPrice: n });
    await tgSend(
      chatId,
      `✅ Confirmed <b>${escapeHtml(job.client.name || job.client.email)}</b> at €${n}. They've been emailed a link to finish booking.`,
    );
    return;
  }

  switch (state.step) {
    case "name":
      draft.name = /^skip$/i.test(text) ? undefined : text;
      await setState({ chatId, flow: state.flow, step: "email", draft });
      await tgSend(chatId, "Client's <b>email</b>?");
      return;
    case "email":
      // The one wizard field with no skip and no form backfill — a typo here
      // sends the quote/booking email into the void. Basic shape check only.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())) {
        await tgSend(
          chatId,
          "That doesn't look like an email address (e.g. <code>client@example.com</code>) — please re-enter it.",
        );
        return;
      }
      draft.email = text.trim();
      await setState({ chatId, flow: state.flow, step: "phone", draft });
      await tgSend(chatId, "Client's <b>phone</b>?", skipKeyboard("phone"));
      return;
    case "phone":
      draft.phone = /^skip$/i.test(text) ? undefined : text;
      await setState({ chatId, flow: state.flow, step: "eircode", draft });
      // Auctioneera + pre-agreed client: the eircode may not be known yet —
      // the client's form backfills it (and book/saveDetails re-seed the BER).
      // The quote + solar flows need it here (zone / partner-table pricing).
      if (state.flow === "auctioneera" || state.flow === "client") {
        await tgSend(
          chatId,
          "Client's <b>eircode</b>? (skip if unknown — the client adds it on the form)",
          skipKeyboard("eircode"),
        );
      } else {
        await tgSend(chatId, "Client's <b>eircode</b>?");
      }
      return;
    case "eircode": {
      if (state.flow === "auctioneera") {
        draft.eircode = /^skip$/i.test(text) ? undefined : text;
        await setState({ chatId, flow: state.flow, step: "price", draft });
        await tgSend(
          chatId,
          "Price the client <b>paid Auctioneera</b> in €? (the full amount — incl VAT and the €30 SEAI fee)",
        );
        return;
      }
      draft.eircode =
        state.flow === "client" && /^skip$/i.test(text) ? undefined : text;
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
      if (state.flow === "solar") {
        // Solar: the client picks property type, slot and details themselves —
        // nothing more to ask. The partner invoice is priced from solar.env
        // once they've chosen the property type.
        await clearState(chatId);
        await createSolarJob(chatId, draft);
        return;
      }
      if (state.flow === "solar_arranged") {
        // Pre-agreed solar: only the slot is fixed here — the client still
        // picks property type (which prices the partner invoice) and details.
        await setState({ chatId, flow: state.flow, step: "datetime", draft });
        await tgSend(chatId, DATETIME_PROMPT, currentMonthCalendar());
        return;
      }
      // client flow — gather the pre-agreed details next
      await setState({ chatId, flow: state.flow, step: "size", draft });
      await tgSend(
        chatId,
        "Property <b>size</b>? Reply <code>apt</code>, <code>lt200</code> (house &lt;200m²), or <code>mt200</code> (house &gt;200m²). Skip if unknown — the client picks it on the form.",
        skipKeyboard("size"),
      );
      return;
    }
    case "size": {
      if (/^skip$/i.test(text)) {
        draft.size = undefined;
      } else {
        const pt = sizeToPropertyType(text);
        if (!pt) {
          await tgSend(
            chatId,
            "Please reply <code>apt</code>, <code>lt200</code>, or <code>mt200</code> — or skip.",
            skipKeyboard("size"),
          );
          return;
        }
        draft.size = text.trim().toLowerCase();
      }
      await setState({ chatId, flow: state.flow, step: "datetime", draft });
      await tgSend(chatId, DATETIME_PROMPT, currentMonthCalendar());
      return;
    }
    case "datetime": {
      if (!parseDateTime(text)) {
        await tgSend(
          chatId,
          "Couldn't read that. Pick a day below, or type <code>YYYY-MM-DD HH:MM</code>, e.g. <code>2026-07-10 14:00</code>",
          currentMonthCalendar(),
        );
        return;
      }
      draft.datetime = text.trim();
      if (state.flow === "solar_arranged") {
        // Solar pricing comes from the partner table once the client picks
        // their property type — nothing more to ask.
        await clearState(chatId);
        await createSolarArrangedJob(chatId, draft);
        return;
      }
      await setState({ chatId, flow: state.flow, step: "price", draft });
      // The zone fallback needs BOTH the eircode (zone) and the size (which
      // price in the zone) — if either was skipped, the price must be typed.
      if (!draft.eircode || !draft.size) {
        await tgSend(
          chatId,
          "Agreed <b>price</b> in €? (required — without the eircode and size there's no zone price to fall back to)",
        );
      } else {
        await tgSend(
          chatId,
          "Agreed <b>price</b> in €? (skip to use the standard zone price)",
          skipKeyboard("price"),
        );
      }
      return;
    }
    case "price": {
      if (state.flow === "auctioneera") {
        // Required (it's what they actually paid), and must exceed the €30
        // SEAI fee the invoice carves out of it.
        const n = Number(text.replace(/[€,\s]/g, ""));
        if (!Number.isFinite(n) || n <= 30) {
          await tgSend(
            chatId,
            "Please enter the amount they paid (a number over 30, e.g. 250).",
          );
          return;
        }
        draft.price = n;
        await clearState(chatId);
        await createAuctioneeraJob(chatId, draft);
        return;
      }
      {
        const priceRequired = !draft.eircode || !draft.size;
        if (/^skip$/i.test(text)) {
          if (priceRequired) {
            await tgSend(
              chatId,
              "The price is required here — the skipped eircode/size leave nothing to compute one from. Please enter a number (e.g. 280).",
            );
            return;
          }
        } else {
          const n = Number(text.replace(/[€,\s]/g, ""));
          if (!Number.isFinite(n) || n < 0) {
            await tgSend(
              chatId,
              priceRequired
                ? "Please enter a number (e.g. 280)."
                : "Please enter a number (e.g. 280), or skip.",
              priceRequired ? undefined : skipKeyboard("price"),
            );
            return;
          }
          draft.price = n;
        }
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
    // Name (and, for Auctioneera, eircode) may be skipped — unknown at booking
    // time; the client fills them in on the form, which backfills the record
    // via setDetails.
    name: draft.name ?? "",
    email: draft.email!,
    phone: draft.phone,
    eircode: draft.eircode ?? "",
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
  // Size may have been skipped (unknown at booking) — the client then picks
  // the property type on the form, exactly like the solar flows.
  const propertyType = draft.size ? sizeToPropertyType(draft.size)! : undefined;
  const dt = parseDateTime(draft.datetime!)!;

  // An explicitly entered price is a trusted override; skipping it falls back
  // to the zone price (for display only — resolveJobPrice recomputes it). The
  // wizard guarantees an explicit price whenever eircode or size was skipped,
  // so the fallback only runs with both in hand.
  const agreed = draft.price;
  let price = agreed;
  if (price == null && propertyType && draft.eircode) {
    const computed = await computeQuotePricing(draft.eircode);
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

  // The pre-agreed booking hinges on the calendar slot. If it fails, don't send
  // the client a "complete your booking" email for a booking that isn't real —
  // discard the half-created job (so it can't linger as a stray quote) and ask
  // the owner to retry.
  let ev: Awaited<ReturnType<typeof createBookedEvent>>;
  try {
    ev = await createBookedEvent(summary, dt.startNaive, dt.endNaive);
  } catch (err) {
    console.error("failed to create calendar event", err);
    await setJobStatus(job.jobId, "discarded");
    await tgSend(
      chatId,
      "❌ Couldn't create the booking — the calendar didn't accept the slot " +
        "(check the Google Calendar connection). Nothing was sent to the client; " +
        "please try again.",
    );
    return;
  }

  // Pre-agreed slot: mark `prebooked`, not `booked`. It becomes `booked` only
  // once the client completes the survey form (so the deferred LoE nudge and the
  // assessor pull don't fire before they've done anything).
  await setBooking(
    job.jobId,
    {
      eventId: ev.id,
      start: ev.start,
      end: ev.end,
      bookedAt: new Date().toISOString(),
    },
    "prebooked",
  );
  // Seed the BER for the tablet (address, satellite image, property type) — the
  // web booking flow does this in book.ts; the Telegram flow must too, or the
  // job reaches the assessor's tablet with no name and no site image.
  // Best-effort: never fail the booking over the seed.
  try {
    await seedBerFromEircode(job, { propertyType });
  } catch (err) {
    console.error(`berSeed generation failed for ${job.jobId}`, err);
  }

  const full = (await getJobById(job.jobId)) ?? job;
  await sendBookingPrefilledEmail(full);

  await tgSend(
    chatId,
    `✅ Booking created for <b>${escapeHtml(job.client.name || `(name TBC) ${job.client.eircode || job.client.email}`)}</b> (${propertyType ?? "size TBC"}${price != null ? `, €${price}` : ""}).\n📅 ${fmtIrish(ev.start)}\n` +
      `Email sent to ${escapeHtml(job.client.email)}.\n\nClient link:\n${clientLink(job.token)}`,
  );
}

// /newsolar: like /newquote from the client's side — they pick property type,
// slot and details themselves — but the invoice goes to the solar partner,
// priced from the solar.env table for whatever property type the client picks.
// The client is never asked to pay or shown a price.
async function createSolarJob(
  chatId: string,
  draft: {
    name?: string;
    email?: string;
    phone?: string;
    eircode?: string;
  },
): Promise<void> {
  const job = await createJob({
    client: clientOf(draft),
    source: "telegram",
    billTo: "solar_partner",
    requireReview: false,
  });

  await sendSolarBookingEmail(job);

  const partner = solarPartner();
  const warnings = [
    !partner.email &&
      "⚠️ SOLAR_PARTNER_EMAIL isn't configured — the invoice won't be emailed to them (you'll still get it on your booking email).",
    !solarPricesConfigured() &&
      "⚠️ The solar price table (SOLAR_PRICE_APARTMENT/SMALL_HOUSE/LARGE_HOUSE) isn't fully configured — their invoice can't be generated until it is.",
  ]
    .filter(Boolean)
    .map((w) => `\n${escapeHtml(w as string)} Set it in secrets/solar.env and redeploy.`)
    .join("");
  await tgSend(
    chatId,
    `✅ Solar job created for <b>${escapeHtml(job.client.name || `(name TBC) ${job.client.eircode}`)}</b> — they pick property type & slot; <b>${escapeHtml(partner.name)}</b> is invoiced when they book.\nBooking email sent to ${escapeHtml(job.client.email)}.${warnings}\n\nClient link:\n${clientLink(job.token)}`,
  );
}

// /newauctioneera: the client already paid Auctioneera in full, so only their
// email and the amount paid are needed here — everything else (name, eircode,
// property type, slot, details) comes from the client's form. The invoice they
// see deducts Auctioneera's commission (see qbInvoice.ts).
async function createAuctioneeraJob(
  chatId: string,
  draft: {
    name?: string;
    email?: string;
    phone?: string;
    eircode?: string;
    price?: number;
  },
): Promise<void> {
  const job = await createJob({
    client: clientOf(draft),
    source: "telegram",
    billTo: "auctioneera",
    requireReview: false,
  });
  // The amount they paid Auctioneera is the trusted, final price (incl VAT +
  // SEAI fee) — it drives the invoice and the LoE fee.
  await setAgreedPrice(job.jobId, draft.price!);

  await sendAuctioneeraBookingEmail(job);

  await tgSend(
    chatId,
    `✅ Auctioneera job created for <b>${escapeHtml(job.client.name || job.client.eircode || job.client.email)}</b> — €${draft.price} paid via Auctioneera (15% commission comes off the invoice).\nBooking email sent to ${escapeHtml(job.client.email)}.\n\nClient link:\n${clientLink(job.token)}`,
  );
}

// /newsolar_arranged: a solar-partner job with a pre-agreed slot. Like
// createPreAgreedJob it books the calendar event up front, but there's no
// size/price — the client picks property type on the form, which is what
// prices the partner invoice (sent once they've completed the form).
async function createSolarArrangedJob(
  chatId: string,
  draft: {
    name?: string;
    email?: string;
    phone?: string;
    eircode?: string;
    datetime?: string;
  },
): Promise<void> {
  const dt = parseDateTime(draft.datetime!)!;

  const job = await createJob({
    client: clientOf(draft),
    source: "telegram",
    billTo: "solar_partner",
    requireReview: false,
  });

  const summary = `BOOKED: ${job.client.name} | ${job.client.eircode} | ${job.client.email}`;

  // Same rule as /newclient: the pre-agreed booking hinges on the calendar
  // slot. If it fails, discard the half-created job and ask the owner to retry.
  let ev: Awaited<ReturnType<typeof createBookedEvent>>;
  try {
    ev = await createBookedEvent(summary, dt.startNaive, dt.endNaive);
  } catch (err) {
    console.error("failed to create calendar event", err);
    await setJobStatus(job.jobId, "discarded");
    await tgSend(
      chatId,
      "❌ Couldn't create the booking — the calendar didn't accept the slot " +
        "(check the Google Calendar connection). Nothing was sent to the client; " +
        "please try again.",
    );
    return;
  }

  await setBooking(
    job.jobId,
    {
      eventId: ev.id,
      start: ev.start,
      end: ev.end,
      bookedAt: new Date().toISOString(),
    },
    "prebooked",
  );
  // Seed the tablet data (address, satellite image). No property type yet —
  // the seed is refreshed with the client's answers when they save the form.
  try {
    await seedBerFromEircode(job);
  } catch (err) {
    console.error(`berSeed generation failed for ${job.jobId}`, err);
  }

  const full = (await getJobById(job.jobId)) ?? job;
  await sendSolarPrefilledEmail(full);

  const partner = solarPartner();
  const warnings = [
    !partner.email &&
      "⚠️ SOLAR_PARTNER_EMAIL isn't configured — the invoice won't be emailed to them (you'll still get it on your booking email).",
    !solarPricesConfigured() &&
      "⚠️ The solar price table (SOLAR_PRICE_PRIMARY/…) isn't fully configured — their invoice can't be generated until it is.",
  ]
    .filter(Boolean)
    .map((w) => `\n${escapeHtml(w as string)} Set it in secrets/solar.env and redeploy.`)
    .join("");
  await tgSend(
    chatId,
    `✅ Pre-agreed solar booking for <b>${escapeHtml(job.client.name || `(name TBC) ${job.client.eircode}`)}</b>.\n📅 ${fmtIrish(ev.start)}\n<b>${escapeHtml(partner.name)}</b> is invoiced once they've filled the form (property type prices it).\nEmail sent to ${escapeHtml(job.client.email)}.${warnings}\n\nClient link:\n${clientLink(job.token)}`,
  );
}

async function handleCallback(cb: any): Promise<void> {
  // Split on the FIRST colon only — time callbacks (tm:…THH:MM) contain more.
  const data = String(cb.data ?? "");
  const sep = data.indexOf(":");
  const action = sep < 0 ? data : data.slice(0, sep);
  const arg = sep < 0 ? "" : data.slice(sep + 1);
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;

  // Filler buttons in the calendar grid (blank cells, weekday labels).
  if (action === "noop") {
    await tgAnswerCallback(cb.id);
    return;
  }

  // Skip button on an optional wizard question. Only honour it if the wizard
  // is still on that exact step — otherwise it's a stale button from an
  // earlier question (or an abandoned conversation).
  if (action === "skip") {
    const state = chatId ? await getState(String(chatId)) : undefined;
    if (!state || state.step !== arg) {
      await tgAnswerCallback(cb.id, "That question is no longer active");
      return;
    }
    await tgAnswerCallback(cb.id);
    // Rewrite the question message so the dead button disappears and the
    // history shows the step was skipped.
    if (chatId && messageId && cb.message?.text) {
      await tgEditText(
        chatId,
        messageId,
        `${escapeHtml(cb.message.text)}\n⏭ <i>Skipped</i>`,
      );
    }
    await advance(String(chatId), state, "skip");
    return;
  }

  // Date/time picker buttons — only live while the wizard is on "datetime".
  if (action === "cal" || action === "day" || action === "tm") {
    const state = chatId ? await getState(String(chatId)) : undefined;
    if (!state || state.step !== "datetime") {
      await tgAnswerCallback(cb.id, "That question is no longer active");
      return;
    }
    if (action === "cal") {
      // Month navigation (also "back to calendar" from the time grid).
      const m = arg.match(/^(\d{4})-(\d{2})$/);
      if (!m) {
        await tgAnswerCallback(cb.id);
        return;
      }
      await tgAnswerCallback(cb.id);
      if (chatId && messageId) {
        await tgEditText(
          chatId,
          messageId,
          DATETIME_PROMPT,
          calendarKeyboard(Number(m[1]), Number(m[2])),
        );
      }
      return;
    }
    if (action === "day") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
        await tgAnswerCallback(cb.id);
        return;
      }
      await tgAnswerCallback(cb.id);
      if (chatId && messageId) {
        await tgEditText(
          chatId,
          messageId,
          `📅 <b>${arg}</b> — now pick a <b>time</b> (Irish time):`,
          timeKeyboard(arg),
        );
      }
      return;
    }
    // tm:YYYY-MM-DDTHH:MM — parseDateTime accepts the T form, so hand it to
    // advance() exactly as if it had been typed.
    if (!parseDateTime(arg)) {
      await tgAnswerCallback(cb.id);
      return;
    }
    await tgAnswerCallback(cb.id);
    if (chatId && messageId) {
      await tgEditText(
        chatId,
        messageId,
        `📅 Appointment: <b>${arg.replace("T", " ")}</b> ✅`,
      );
    }
    await advance(String(chatId), state, arg);
    return;
  }

  const jobId = arg;
  const job = jobId ? await getJobById(jobId) : undefined;
  if (!job) {
    await tgAnswerCallback(cb.id, "Job not found");
    return;
  }

  // Confirm a gated booking. Out-of-zone bookings need an agreed price first —
  // kick off the confirm_price wizard; post-works-only bookings confirm outright.
  if (action === "cbook") {
    if (job.confirmGate?.status === "approved") {
      await tgAnswerCallback(cb.id, "Already confirmed");
      return;
    }
    const needsPrice = job.confirmGate?.reasons?.includes("outside-zone");
    if (needsPrice && chatId) {
      await setState({
        chatId: String(chatId),
        flow: "confirm_price",
        step: "price",
        draft: { jobId },
      });
      await tgAnswerCallback(cb.id);
      if (messageId && cb.message?.text) {
        await tgEditText(chatId, messageId, `${escapeHtml(cb.message.text)}\n\n✅ <i>Confirming…</i>`);
      }
      await tgSend(
        chatId,
        `Confirming <b>${escapeHtml(job.client.name || job.client.email)}</b> (outside your zones). Enter the agreed <b>price</b> in € (overrides the €400 flat rate):`,
      );
      return;
    }
    await approveBooking(job);
    await tgAnswerCallback(cb.id, "Confirmed");
    if (chatId && messageId) {
      await tgEditText(
        chatId,
        messageId,
        `✅ Confirmed <b>${escapeHtml(job.client.name || job.client.email)}</b> — emailed a link to finish booking.`,
      );
    }
    return;
  }

  if (action === "rbook") {
    await rejectBooking(job);
    await tgAnswerCallback(cb.id, "Rejected");
    if (chatId && messageId) {
      await tgEditText(
        chatId,
        messageId,
        `🗑 Rejected booking for <b>${escapeHtml(job.client.name || job.client.email)}</b> — job discarded, client emailed.`,
      );
    }
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
