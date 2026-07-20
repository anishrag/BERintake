// POST /signwell/webhook — SignWell posts document lifecycle events here.
// On `document_completed` we mark the job's letter of engagement signed.

import { timingSafeEqual } from "node:crypto";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { findJobByLoeDocId, setJobStatus, setLoeStatus } from "../shared/jobs";
import { sendAllSetEmail, sendOwnerSignedEmail } from "../shared/notify";
import { hydrateSecrets } from "../shared/secrets";

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
  // Authenticate: the SignWell callback URL carries a secret token (?t=…) that
  // only SignWell has. Reject anything without the right token (fail closed if
  // the token env var is unset).
  if (!secretsMatch(event.queryStringParameters?.t, process.env.SIGNWELL_WEBHOOK_TOKEN)) {
    console.warn("signwell webhook rejected — missing/invalid token");
    return unauthorized();
  }

  let payload: any;
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return ok();
  }

  const type = payload?.event?.type;
  const documentId = payload?.data?.object?.id;
  if (type !== "document_completed" || !documentId) return ok();

  try {
    const job = await findJobByLoeDocId(documentId);
    if (!job) {
      console.warn(`no job for completed LOE doc ${documentId}`);
    } else if (job.loe?.status !== "completed") {
      // First completion only — SignWell may retry the webhook. Signing is the
      // last online step, so this sends the terminal "you're all set" email.
      await setLoeStatus(job.jobId, "completed");
      // Reflect the signature in the top-level status too, so a signed job reads
      // as `signed` regardless of whether the client's browser ever fired the
      // confirm step. Only advance from `booked` — never regress a job that's
      // already further along (confirmed/pulled/surveyed).
      if (job.status === "booked") await setJobStatus(job.jobId, "signed");
      try {
        await sendAllSetEmail(job);
      } catch (err) {
        console.error("all-set email failed for", job.jobId, err);
      }
      // Owner notification: client has signed, with details + invoice attached.
      try {
        await sendOwnerSignedEmail(job);
      } catch (err) {
        console.error("owner signed email failed for", job.jobId, err);
      }
    }
  } catch (err) {
    console.error("signwell webhook error", err);
  }
  return ok();
};
