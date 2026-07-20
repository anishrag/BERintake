// POST /jobs/{token}/invoice — create (or return) the QuickBooks invoice for
// this job. The client form calls this before showing the invoice + Pay.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  pendingConfirmation,
  requestOwnerConfirmation,
} from "../shared/confirmation";
import { getJobByToken } from "../shared/jobs";
import { ensureInvoiceForJob } from "../shared/qbInvoice";
import { isSolarJob } from "../shared/solarPartner";
import { allowRequest, clientIp } from "../shared/rateLimit";
import { hydrateSecrets } from "../shared/secrets";

// Only mint a QB invoice once the client has committed to a slot (held it) or
// booked — stops a bare token from creating QuickBooks junk.
const BOOKED_STATUSES = ["booked", "paid", "signed", "confirmed", "pulled"];

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  const token = event.pathParameters?.token;
  if (!token) return json(400, { error: "missing token" });

  if (!(await allowRequest(clientIp(event), "invoice", 20, 60))) {
    return json(429, { error: "rate-limited" });
  }

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") return json(404, { error: "not found" });
  // Solar-partner jobs: the invoice is the partner's, not the client's — the
  // client link must not be able to mint or read it.
  if (isSolarJob(job)) return json(404, { error: "not found" });
  if (!job.hold && !BOOKED_STATUSES.includes(job.status)) {
    return json(409, { error: "not-ready" });
  }

  // Owner-confirmation gate: never mint an invoice for a post-works or
  // outside-zone booking until the owner has confirmed it (ping them once).
  const reasons = await pendingConfirmation(job);
  if (reasons.length) {
    await requestOwnerConfirmation(job, reasons);
    return json(409, { error: "needs-confirmation", reasons });
  }

  try {
    const inv = await ensureInvoiceForJob(job);
    return json(200, { invoiceId: inv.id, total: inv.total, docNumber: inv.docNumber });
  } catch (err: any) {
    if (err?.message === "no-price") return json(400, { error: "no-price" });
    console.error("invoice generation failed", err);
    return json(502, { error: "invoice-failed" });
  }
};
