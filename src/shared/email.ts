// SES email sender. The cannygreen.com domain is a verified SES identity, so
// the From address just needs to be @cannygreen.com (QUOTE_FROM_EMAIL).

import {
  SendEmailCommand,
  SendRawEmailCommand,
  SESClient,
} from "@aws-sdk/client-ses";
import { emailFooterHtml, emailFooterText } from "./company";

const ses = new SESClient({});

// Append the company-particulars footer (CRO / Revenue disclosure) to every
// client-facing email.
function withFooter(text: string, html: string): { text: string; html: string } {
  return { text: `${text}\n\n${emailFooterText}`, html: `${html}${emailFooterHtml}` };
}

export interface Attachment {
  filename: string;
  content: Buffer;
  contentType?: string; // defaults to application/pdf
}

function fromAddress(): string {
  return process.env.QUOTE_FROM_EMAIL || "test@cannygreen.com";
}

// Testing override: when TEST_EMAIL_OVERRIDE is a real address, redirect every
// email there and flag the intended recipient in the subject. "off"/"none"/blank
// = send to the real recipient.
function route(to: string, subject: string): { to: string; subject: string } {
  const ov = process.env.TEST_EMAIL_OVERRIDE?.trim();
  const useOverride = !!ov && !["off", "none", ""].includes(ov.toLowerCase());
  return useOverride
    ? { to: ov!, subject: `[TEST → ${to}] ${subject}` }
    : { to, subject };
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const { to, subject } = route(opts.to, opts.subject);
  const body = withFooter(opts.text, opts.html);
  await ses.send(
    new SendEmailCommand({
      Source: fromAddress(),
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: {
          Text: { Data: body.text },
          Html: { Data: body.html },
        },
      },
    }),
  );
}

// Same as sendEmail but with file attachments. SendEmail can't carry
// attachments, so build a MIME message and send it raw.
export async function sendEmailWithAttachments(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: Attachment[];
}): Promise<void> {
  const from = fromAddress();
  const { to, subject } = route(opts.to, opts.subject);
  const body = withFooter(opts.text, opts.html);
  const raw = buildMimeMessage({
    from,
    to,
    subject,
    text: body.text,
    html: body.html,
    attachments: opts.attachments,
  });
  await ses.send(
    new SendRawEmailCommand({
      Source: from,
      Destinations: [to],
      RawMessage: { Data: raw },
    }),
  );
}

// --- MIME construction ---

const CRLF = "\r\n";

// base64, wrapped to 76-char lines per RFC 2045.
function b64Lines(buf: Buffer): string {
  return (buf.toString("base64").match(/.{1,76}/g) ?? []).join(CRLF);
}

// RFC 2047-encode a header value if it isn't plain ASCII (subjects use €, — …).
function encodeHeader(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function boundary(tag: string): string {
  return `${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function buildMimeMessage(m: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: Attachment[];
}): Uint8Array {
  const mixed = boundary("mixed");
  const alt = boundary("alt");
  const lines: string[] = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeader(m.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(Buffer.from(m.text, "utf8")),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(Buffer.from(m.html, "utf8")),
    `--${alt}--`,
  ];
  for (const att of m.attachments) {
    lines.push(
      `--${mixed}`,
      `Content-Type: ${att.contentType ?? "application/pdf"}; name="${att.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${att.filename}"`,
      "",
      b64Lines(att.content),
    );
  }
  lines.push(`--${mixed}--`, "");
  return new TextEncoder().encode(lines.join(CRLF));
}
