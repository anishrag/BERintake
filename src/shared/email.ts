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

  // Testing override: when set to a real address, redirect every email there
  // and flag the intended recipient in the subject. "off"/"none"/blank = send
  // to the real recipient.
  const ov = process.env.TEST_EMAIL_OVERRIDE?.trim();
  const useOverride = !!ov && !["off", "none", ""].includes(ov.toLowerCase());
  const to = useOverride ? ov! : opts.to;
  const subject = useOverride ? `[TEST → ${opts.to}] ${opts.subject}` : opts.subject;

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
