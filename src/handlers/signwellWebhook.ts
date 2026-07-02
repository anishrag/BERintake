// POST /signwell/webhook — SignWell posts document lifecycle events here.
// On `document_completed` we mark the job's letter of engagement signed.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { findJobByLoeDocId, setLoeStatus } from "../shared/jobs";
import { sendAllSetEmail } from "../shared/notify";

const ok = (): APIGatewayProxyResultV2 => ({ statusCode: 200, body: "ok" });

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
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
      try {
        await sendAllSetEmail(job);
      } catch (err) {
        console.error("all-set email failed for", job.jobId, err);
      }
    }
  } catch (err) {
    console.error("signwell webhook error", err);
  }
  return ok();
};
