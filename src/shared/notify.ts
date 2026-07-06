// Client-facing notifications. Sent automatically when a job becomes
// quote_sent (Telegram /newclient, partner approval, or web admin).

import {
  type Attachment,
  sendEmail,
  sendEmailWithAttachments,
} from "./email";
import { escapeHtml } from "./html";
import { clientLink } from "./jobs";
import { ensureInvoiceForJob, getInvoicePdf } from "./qbInvoice";
import { getSignedLoePdf } from "./signwell";
import type { Job } from "./types";

// Best-effort attachment fetchers — never let a missing PDF block the email.
async function invoiceAttachment(job: Job): Promise<Attachment | null> {
  try {
    const inv = await ensureInvoiceForJob(job);
    return { filename: "invoice.pdf", content: await getInvoicePdf(inv.id) };
  } catch (err) {
    console.error("could not attach invoice for", job.jobId, err);
    return null;
  }
}

async function signedLoeAttachment(job: Job): Promise<Attachment | null> {
  const documentId = job.loe?.documentId;
  if (!documentId) return null;
  try {
    return {
      filename: "letter-of-engagement.pdf",
      content: await getSignedLoePdf(documentId),
    };
  } catch (err) {
    console.error("could not attach signed LoE for", job.jobId, err);
    return null;
  }
}

// Send with attachments when there are any, otherwise a plain email.
async function deliver(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: Attachment[];
}): Promise<void> {
  if (opts.attachments.length) {
    await sendEmailWithAttachments(opts);
  } else {
    const { to, subject, text, html } = opts;
    await sendEmail({ to, subject, text, html });
  }
}

const PROPERTY_LABELS: Record<string, string> = {
  apartment: "Apartment",
  "small-house": "House (under 200 m²)",
  "large-house": "House (over 200 m²)",
};

// The appointment start, formatted for Irish readers. "" if not booked yet.
function apptWhen(job: Job): string {
  const start = (job.booking as any)?.start;
  if (!start) return "";
  try {
    return new Date(start).toLocaleString("en-IE", {
      timeZone: "Europe/Dublin",
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

const SHELL =
  "font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px";
const BTN =
  "background:#2e7d32;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:600;display:inline-block";

// --- Owner (business) notifications -----------------------------------------
// The owner gets an email when a client completes the booking form and when they
// sign the letter of engagement, each with the client's details and a copy of
// the invoice to confirm everything looks right. Recipient via OWNER_EMAIL.
const OWNER_EMAIL = (): string => process.env.OWNER_EMAIL || "anish@cannygreen.com";

function fmtWhen(iso?: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-IE", {
      timeZone: "Europe/Dublin",
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// A readable rundown of the client + survey details for owner emails. `kd` is
// the job's keyDetails (the survey form fields).
function detailRows(
  job: Job,
  kd: any,
  appointmentIso?: string | null,
): [string, string][] {
  const c = job.client;
  const ext = Array.isArray(kd?.extensions) ? kd.extensions : [];
  const extStr = ext
    .map((e: any) => (e.description ? `${e.year} (${e.description})` : `${e.year}`))
    .join(", ");
  const insul = [
    kd?.insulationWalls && "walls",
    kd?.insulationRoof && "roof/attic",
    kd?.insulationFloor && "floor",
  ]
    .filter(Boolean)
    .join(", ");
  const raw: [string, unknown][] = [
    ["Appointment", fmtWhen(appointmentIso ?? (job.booking as any)?.start)],
    ["Name", c.name],
    ["Address", kd?.address],
    ["Eircode", c.eircode],
    ["Email", c.email],
    ["Phone", c.phone],
    ["Reason for BER", kd?.reason],
    ["MPRN", kd?.mprn],
    ["Year built", kd?.yearBuilt],
    ["Heating system", kd?.heatingSystem],
    ["Extensions", extStr],
    ["Insulation works", insul],
    ["Insulation notes", kd?.insulationNotes],
    ["Windows installed", kd?.windowYearUnknown ? "Unknown" : kd?.windowYear],
    ["Doors installed", kd?.doorYearUnknown ? "Unknown" : kd?.doorYear],
    ["Comments", kd?.comments],
  ];
  return raw
    .map(([k, v]) => [k, v == null ? "" : String(v).trim()] as [string, string])
    .filter(([, v]) => v !== "");
}

async function sendOwnerEmail(
  subject: string,
  intro: string,
  rows: [string, string][],
  attachments: Attachment[],
): Promise<void> {
  const text = `${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}`;
  const html = `<div style="${SHELL}">
  <p>${escapeHtml(intro)}</p>
  <table style="border-collapse:collapse;font-size:14px">
    ${rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:2px 14px 2px 0;color:#555;vertical-align:top"><strong>${escapeHtml(k)}</strong></td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`,
      )
      .join("")}
  </table>
</div>`;
  await deliver({ to: OWNER_EMAIL(), subject, text, html, attachments });
}

/** Owner email: a client has completed the booking form. */
export async function sendOwnerNewBookingEmail(
  job: Job,
  kd: unknown,
  appointmentIso?: string | null,
): Promise<void> {
  const inv = await invoiceAttachment(job);
  await sendOwnerEmail(
    `New booking — ${job.client.name} (${job.client.eircode})`,
    `${job.client.name} has completed the booking form. Details and invoice below.`,
    detailRows(job, kd, appointmentIso),
    inv ? [inv] : [],
  );
}

/** Owner email: a client has signed the letter of engagement (funnel complete). */
export async function sendOwnerSignedEmail(job: Job): Promise<void> {
  const inv = await invoiceAttachment(job);
  await sendOwnerEmail(
    `Signed LoE — ${job.client.name} (${job.client.eircode})`,
    `${job.client.name} has signed the letter of engagement — everything's complete. Details and invoice below.`,
    detailRows(job, job.keyDetails),
    inv ? [inv] : [],
  );
}

// Email #3 — the terminal "you're all set" email, sent once the client has
// signed the letter of engagement. Signing is the last thing they do online
// (payment is handled earlier), so this is the end of the funnel.
export async function sendAllSetEmail(job: Job): Promise<void> {
  const firstName = job.client.name.split(" ")[0] || "there";
  const website = "https://cannygreen.com";
  const when = apptWhen(job);

  const text = `Hi ${firstName},

You're all set — thank you for booking your BER assessment${when ? ` for ${when}` : ""}.

That's everything sorted from your side. To see what to expect on the day, have a look at our website:
${website}

I look forward to meeting you.

Kind regards,
Anish
Cannygreen`;

  const html = `<div style="${SHELL}">
  <p>Hi ${escapeHtml(firstName)},</p>
  <p>You're <strong>all set</strong> — thank you for booking your BER assessment${when ? ` for <strong>${when}</strong>` : ""}.</p>
  <p>That's everything sorted from your side. To see what to expect on the day, have a look at our website:<br>
  <a href="${website}" style="color:#2e7d32">${website}</a></p>
  <p>I look forward to meeting you.</p>
  <p>Kind regards,<br><strong>Anish</strong><br>Cannygreen</p>
</div>`;

  // Always attach the signed letter of engagement. Attach the invoice too, but
  // only if the LoE-nudge email (#2, which carries it) wasn't sent — so the
  // client never gets the invoice twice.
  const attachments: Attachment[] = [];
  const loe = await signedLoeAttachment(job);
  if (loe) attachments.push(loe);
  if (!job.sentEmails?.includes("loe_nudge")) {
    const inv = await invoiceAttachment(job);
    if (inv) attachments.push(inv);
  }
  await deliver({
    to: job.client.email,
    subject: "Cannygreen BER - You're all set, see you on the day",
    text,
    html,
    attachments,
  });
}

// Email #1 — the quote. Deferred ~1h after the client gets their price and
// enters the booking form; the sweep sends it only if they haven't booked yet.
export async function sendQuoteEmail(job: Job): Promise<void> {
  const firstName = job.client.name.split(" ")[0] || "there";
  const link = clientLink(job.token);
  const propertyType = (job.quote as any)?.propertyType as string | undefined;
  const price = (job.quote as any)?.price as number | undefined;
  const propLabel = propertyType
    ? PROPERTY_LABELS[propertyType] ?? propertyType
    : "your property";
  const priceLine =
    price != null
      ? `Your BER assessment quote is €${price} for ${propLabel} at ${job.client.eircode}.`
      : `We'll confirm the exact price for ${propLabel} at ${job.client.eircode} shortly.`;

  const text = `Hi ${firstName},

Thanks for your enquiry with Cannygreen.

${priceLine}

You started booking but didn't finish — no problem. When you're ready, just pick up where you left off here:
${link}

If you have any questions, simply reply to this email.

Kind regards,
Anish
Cannygreen`;

  const html = `<div style="${SHELL}">
  <p>Hi ${escapeHtml(firstName)},</p>
  <p>Thanks for your enquiry with Cannygreen.</p>
  <p><strong>${escapeHtml(priceLine)}</strong></p>
  <p>You started booking but didn't finish — no problem. When you're ready, just pick up where you left off:</p>
  <p style="text-align:center;margin:28px 0">
    <a href="${link}" style="${BTN}">Finish my booking</a>
  </p>
  <p>If you have any questions, simply reply to this email.</p>
  <p>Kind regards,<br><strong>Anish</strong><br>Cannygreen</p>
</div>`;

  await sendEmail({
    to: job.client.email,
    subject: "Cannygreen BER - Your quote, a couple of details needed",
    text,
    html,
  });
}

// Email #2 — booked, please sign the letter of engagement. Deferred ~10 min
// after booking; the sweep sends it only if the LoE isn't signed yet.
export async function sendLoeNudgeEmail(job: Job): Promise<void> {
  const firstName = job.client.name.split(" ")[0] || "there";
  const link = clientLink(job.token);
  const when = apptWhen(job);

  const text = `Hi ${firstName},

Your BER assessment is booked${when ? ` for ${when}` : ""} — thank you.

There's one last step to confirm it: please read and sign your letter of engagement. It only takes a minute:
${link}

Kind regards,
Anish
Cannygreen`;

  const html = `<div style="${SHELL}">
  <p>Hi ${escapeHtml(firstName)},</p>
  <p>Your BER assessment is <strong>booked</strong>${when ? ` for <strong>${when}</strong>` : ""} — thank you.</p>
  <p>There's one last step to confirm it: please read and sign your <strong>letter of engagement</strong>. It only takes a minute:</p>
  <p style="text-align:center;margin:28px 0">
    <a href="${link}" style="${BTN}">Read &amp; sign the letter of engagement</a>
  </p>
  <p>Kind regards,<br><strong>Anish</strong><br>Cannygreen</p>
</div>`;

  // Attach the invoice — this is the email that carries it before signing.
  const inv = await invoiceAttachment(job);
  await deliver({
    to: job.client.email,
    subject: "Cannygreen BER - One step left, sign your letter of engagement",
    text,
    html,
    attachments: inv ? [inv] : [],
  });
}

// Sent for a pre-agreed booking (Telegram /newclient): the slot is set, the
// client just needs to add property details and finalise (pay/sign/confirm).
export async function sendBookingPrefilledEmail(job: Job): Promise<void> {
  const firstName = job.client.name.split(" ")[0] || "there";
  const link = clientLink(job.token);
  let when = "";
  const start = (job.booking as any)?.start;
  if (start) {
    try {
      when = new Date(start).toLocaleString("en-IE", {
        timeZone: "Europe/Dublin",
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      when = "";
    }
  }

  const text = `Hi ${firstName},

Thanks for arranging your BER assessment${when ? ` for ${when}` : ""}.

To confirm your booking, please open the link below to add a few details about the property and sign the letter of engagement:

${link}

Kind regards,
Anish
Cannygreen`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
  <p>Hi ${escapeHtml(firstName)},</p>
  <p>Thanks for arranging your BER assessment${when ? ` for <strong>${when}</strong>` : ""}.</p>
  <p>To confirm your booking, please open the link below to add a few property details and sign the letter of engagement:</p>
  <p style="text-align:center;margin:28px 0">
    <a href="${link}" style="background:#2e7d32;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:600;display:inline-block">Add my details</a>
  </p>
  <p>Kind regards,<br><strong>Anish</strong><br>Cannygreen</p>
</div>`;

  await sendEmail({
    to: job.client.email,
    subject: "Cannygreen BER - A couple of details before your assessment",
    text,
    html,
  });
}

export async function sendQuoteRequestEmail(job: Job): Promise<void> {
  const firstName = job.client.name.split(" ")[0] || "there";
  const link = clientLink(job.token);
  const reviews = "https://tinyurl.com/cannygreen-reviews";

  const text = `Hi ${firstName},

Thank you for requesting a BER assessment quote.

To generate your quote I just need a couple of minor details from you. You can add them, see your price, and book your assessment all in one place here:

${link}

What to expect:
- The assessment takes about 1 hour at the property. I'll need access to all parts of the house, and I'll take measurements and photographs as evidence.
- Once I've gathered everything on site, it takes up to a week to compile it all and issue your BER certificate.
- Occasionally, insulation work isn't visible or measurable on site. If that applies to your home, I may need some documentation to support it. I'll work with you after the survey to tell you exactly what's needed, if anything.

You can read my Google reviews here:
${reviews}

If you have any questions, just reply to this email.

Kind regards,
Anish
Cannygreen`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
  <p>Hi ${escapeHtml(firstName)},</p>

  <p>Thank you for requesting a BER assessment quote.</p>

  <p>To generate your quote I just need a couple of minor details from you. You can add them, see your price, and book your assessment all in one place:</p>

  <p style="text-align:center;margin:28px 0">
    <a href="${link}" style="background:#2e7d32;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:600;display:inline-block">Get my quote &amp; book</a>
  </p>

  <p style="margin-bottom:6px"><strong>What to expect</strong></p>
  <ul style="margin-top:0;padding-left:20px">
    <li>The assessment takes about <strong>1 hour</strong> at the property. I'll need access to all parts of the house, and I'll take measurements and photographs as evidence.</li>
    <li>Once I've gathered everything on site, it takes <strong>up to a week</strong> to compile it all and issue your BER certificate.</li>
    <li>Occasionally, insulation work isn't visible or measurable on site. If that applies to your home, I may need some documentation to support it &mdash; I'll work with you after the survey to tell you exactly what's needed, if anything.</li>
  </ul>

  <p>You can read my Google reviews here:<br>
  <a href="${reviews}" style="color:#2e7d32">${reviews}</a></p>

  <p>If you have any questions, just reply to this email.</p>

  <p>Kind regards,<br><strong>Anish</strong><br>Cannygreen</p>
</div>`;

  await sendEmail({
    to: job.client.email,
    subject: "Cannygreen BER - Your quote, a couple of details needed",
    text,
    html,
  });
}
