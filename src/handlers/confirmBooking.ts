// POST /jobs/{token}/confirm — called when the client has completed all
// finalisation steps. Marks the job confirmed (once) and emails them.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobByToken, setJobStatus } from "../shared/jobs";
import { sendBookingConfirmedEmail } from "../shared/notify";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const token = event.pathParameters?.token;
  if (!token) return json(400, { error: "missing token" });

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") return json(404, { error: "not found" });

  // Idempotent — only confirm + email once.
  if (job.status === "confirmed") {
    return json(200, { status: "confirmed", alreadyConfirmed: true });
  }

  await setJobStatus(job.jobId, "confirmed");
  try {
    await sendBookingConfirmedEmail(job);
  } catch (err) {
    console.error("failed to send confirmation email", err);
  }
  return json(200, { status: "confirmed" });
};
