// Client-facing notifications. Sent automatically when a job becomes
// quote_sent (Telegram /newclient, partner approval, or web admin).

import { sendEmail } from "./email";
import { clientLink } from "./jobs";
import type { Job } from "./types";

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
