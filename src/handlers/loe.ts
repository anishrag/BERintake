// POST /jobs/{token}/loe — create (or return) the SignWell Letter of
// Engagement for this job and hand back an embedded signing URL.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  pendingConfirmation,
  requestOwnerConfirmation,
} from "../shared/confirmation";
import { getJobByToken, setLoe } from "../shared/jobs";
import { allowRequest, clientIp } from "../shared/rateLimit";
import { createLoeDocument } from "../shared/signwell";
import { hydrateSecrets } from "../shared/secrets";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// A SignWell document costs money, so only create one for a committed booking.
const BOOKED_STATUSES = ["booked", "paid", "signed", "confirmed", "pulled"];

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  const token = event.pathParameters?.token;
  if (!token) return json(400, { error: "missing token" });

  if (!(await allowRequest(clientIp(event), "loe", 10, 60))) {
    return json(429, { error: "rate-limited" });
  }

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") return json(404, { error: "not found" });
  if (!BOOKED_STATUSES.includes(job.status)) {
    return json(409, { error: "not-booked" });
  }

  // Defence-in-depth: a booked job can't reach here ungated (book.ts blocks
  // first), but never create a paid SignWell document for an unconfirmed
  // post-works / outside-zone booking.
  const reasons = await pendingConfirmation(job);
  if (reasons.length) {
    await requestOwnerConfirmation(job, reasons);
    return json(409, { error: "needs-confirmation", reasons });
  }

  // Reuse the existing document if one is in progress.
  if (job.loe?.documentId && job.loe.status !== "completed") {
    return json(200, { signingUrl: job.loe.signingUrl, status: job.loe.status });
  }
  if (job.loe?.status === "completed") {
    return json(200, { status: "completed" });
  }

  try {
    const doc = await createLoeDocument(job);
    const loe = {
      documentId: doc.documentId,
      signingUrl: doc.signingUrl,
      status: "sent",
      createdAt: new Date().toISOString(),
    };
    await setLoe(job.jobId, loe);
    return json(200, { signingUrl: doc.signingUrl, status: "sent" });
  } catch (err) {
    console.error("loe creation failed", err);
    return json(502, { error: "loe-failed" });
  }
};
