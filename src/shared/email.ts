// SES email sender. The cannygreen.com domain is a verified SES identity, so
// the From address just needs to be @cannygreen.com (QUOTE_FROM_EMAIL).

import { SendEmailCommand, SESClient } from "@aws-sdk/client-ses";

const ses = new SESClient({});

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const from = process.env.QUOTE_FROM_EMAIL || "test@cannygreen.com";

  // Testing override: when set, redirect every email here and flag the real
  // intended recipient in the subject. Leave blank in production.
  const override = process.env.TEST_EMAIL_OVERRIDE?.trim();
  const to = override || opts.to;
  const subject = override ? `[TEST → ${opts.to}] ${opts.subject}` : opts.subject;

  await ses.send(
    new SendEmailCommand({
      Source: from,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: {
          Text: { Data: opts.text },
          Html: { Data: opts.html },
        },
      },
    }),
  );
}
