// Client-facing notifications. Sent automatically when a job becomes
// quote_sent (Telegram /newclient, partner approval, or web admin).

import { sendEmail } from "./email";
import { clientLink } from "./jobs";
import type { Job } from "./types";

export async function sendBookingConfirmedEmail(job: Job): Promise<void> {
  const firstName = job.client.name.split(" ")[0] || "there";
  const website = "https://cannygreen.ie";
  let when = "";
  const start = (job.booking as any)?.start;
  if (start) {
    try {
      when = new Date(start).toLocaleString("en-IE", {
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

Your BER assessment is now booked and confirmed${when ? ` for ${when}` : ""}.

Thank you for completing everything — payment, the letter of engagement, and confirming access.

To see what to expect on the day, have a look at our website:
${website}

I look forward to meeting you.

Kind regards,
Anish
Cannygreen`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
  <p>Hi ${firstName},</p>
  <p>Your BER assessment is now <strong>booked and confirmed</strong>${when ? ` for <strong>${when}</strong>` : ""}.</p>
  <p>Thank you for completing everything — payment, the letter of engagement, and confirming access.</p>
  <p>To see what to expect on the day, have a look at our website:<br>
  <a href="${website}" style="color:#2e7d32">${website}</a></p>
  <p>I look forward to meeting you.</p>
  <p>Kind regards,<br><strong>Anish</strong><br>Cannygreen</p>
</div>`;

  await sendEmail({
    to: job.client.email,
    subject: "You're booked! — Cannygreen BER assessment",
    text,
    html,
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

To confirm your booking, please open the link below to add a few details about the property, pay, and sign the letter of engagement:

${link}

Your appointment isn't fully confirmed until those steps are complete.

Kind regards,
Anish
Cannygreen`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
  <p>Hi ${firstName},</p>
  <p>Thanks for arranging your BER assessment${when ? ` for <strong>${when}</strong>` : ""}.</p>
  <p>To confirm your booking, please open the link below to add a few property details, pay, and sign the letter of engagement:</p>
  <p style="text-align:center;margin:28px 0">
    <a href="${link}" style="background:#2e7d32;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:600;display:inline-block">Complete my booking</a>
  </p>
  <p><em>Your appointment isn't fully confirmed until those steps are complete.</em></p>
  <p>Kind regards,<br><strong>Anish</strong><br>Cannygreen</p>
</div>`;

  await sendEmail({
    to: job.client.email,
    subject: "Complete your BER booking — Cannygreen",
    text,
    html,
  });
}

// A gentle nudge for a booking where the client hasn't finished the steps.
export async function sendReminderEmail(
  job: Job,
  kind: "post24h" | "daybefore" = "post24h",
): Promise<void> {
  const firstName = job.client.name.split(" ")[0] || "there";
  const link = clientLink(job.token);
  const signed = (job.loe as any)?.status === "completed";
  const outstanding = signed
    ? "add your payment details"
    : "add your payment details and sign the letter of engagement";

  const opener =
    kind === "daybefore"
      ? "Your BER assessment is coming up soon."
      : "Just a quick note about your BER booking.";
  const subject =
    kind === "daybefore"
      ? "Your BER assessment is coming up — one step left"
      : "Finish your BER booking — Cannygreen";

  const text = `Hi ${firstName},

${opener} To confirm it, please ${outstanding}. It only takes a minute:

${link}

Kind regards,
Anish
Cannygreen`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
  <p>Hi ${firstName},</p>
  <p>${opener} To confirm it, please ${outstanding}. It only takes a minute:</p>
  <p style="text-align:center;margin:28px 0">
    <a href="${link}" style="background:#2e7d32;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:600;display:inline-block">Complete my booking</a>
  </p>
  <p>Kind regards,<br><strong>Anish</strong><br>Cannygreen</p>
</div>`;

  await sendEmail({ to: job.client.email, subject, text, html });
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
  <p>Hi ${firstName},</p>

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
    subject: "Your BER quote with Cannygreen — a couple of details needed",
    text,
    html,
  });
}
