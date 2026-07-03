// POST /jobs — the HTTP front door used by the partner web form (and any
// future web-admin page). Partner submissions land in `pending_review` and
// ping the owner on Telegram with Send/Discard buttons.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { clientLink, createJob } from "../shared/jobs";
import { sendQuoteRequestEmail } from "../shared/notify";
import { allowRequest, clientIp } from "../shared/rateLimit";
import { notifyOwner } from "../shared/telegram";
import { verifyTurnstile } from "../shared/turnstile";
import type { JobSource } from "../shared/types";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if (!(await allowRequest(clientIp(event), "createjob", 5, 60))) {
    return json(429, { error: "rate-limited" });
  }

  let body: Record<string, unknown>;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  // Every create path is authenticated — no anonymous job creation:
  //  - web        : public self-serve, gated by a Turnstile CAPTCHA
  //  - partner    : the partner form, gated by the shared access key
  //  - web_admin  : your own admin tooling, gated by the access key
  const raw = body.source;
  const source: JobSource =
    raw === "web" ? "web" : raw === "web_admin" ? "web_admin" : "partner";

  if (source === "web") {
    const ip = (event.requestContext as any)?.http?.sourceIp;
    const ok = await verifyTurnstile(
      typeof body.captchaToken === "string" ? body.captchaToken : undefined,
      ip,
    );
    if (!ok) return json(401, { error: "captcha failed" });
  } else {
    // partner / web_admin require the shared access key.
    const key = process.env.PARTNER_ACCESS_KEY;
    if (!key || body.accessKey !== key) {
      return json(401, { error: "invalid access key" });
    }
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const eircode = typeof body.eircode === "string" ? body.eircode.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : undefined;
  const note = typeof body.note === "string" ? body.note.trim() : undefined;
  const partnerName =
    typeof body.partnerName === "string" ? body.partnerName.trim() : undefined;

  if (!name || !email || !eircode) {
    return json(400, { error: "name, email and eircode are required" });
  }

  const requireReview = source === "partner";
  const job = await createJob({
    client: { name, email, phone, eircode },
    source,
    partnerName: source === "partner" ? partnerName : undefined,
    note,
    requireReview,
  });

  if (job.status === "pending_review") {
    const who = job.partnerName
      ? `partner <b>${job.partnerName}</b>`
      : "a partner";
    await notifyOwner(
      `🆕 New job from ${who}\n\n` +
        `<b>${job.client.name}</b>\n` +
        `✉️ ${job.client.email}\n` +
        `📞 ${job.client.phone ?? "no phone"}\n` +
        `📍 ${job.client.eircode}` +
        (job.note ? `\n\n📝 ${job.note}` : ""),
      {
        inline_keyboard: [
          [
            { text: "✅ Send quote link", callback_data: `approve:${job.jobId}` },
            { text: "🗑 Discard", callback_data: `discard:${job.jobId}` },
          ],
        ],
      },
    );
    return json(201, {
      jobId: job.jobId,
      status: job.status,
      message: "Submitted — pending review",
    });
  }

  // web_admin (owner created the job on the client's behalf) → email the client
  // their quote link. Pure web self-serve doesn't need it: the browser already
  // has the link and drops the client straight into the funnel, and if they
  // stall the deferred quote email (sweepDeferredEmails) covers it.
  if (source !== "web") {
    await sendQuoteRequestEmail(job);
  }
  return json(201, {
    jobId: job.jobId,
    status: job.status,
    token: job.token,
    clientLink: clientLink(job.token),
  });
};
