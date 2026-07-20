// POST /jobs/{token}/confirm — called when the client has completed all
// finalisation steps. Marks the job confirmed (once) for the assessor pipeline.
// The client email is sent earlier, on signing (signwellWebhook).

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobByToken, setJobStatus } from "../shared/jobs";
import { hydrateSecrets } from "../shared/secrets";

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

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") return json(404, { error: "not found" });

  // Idempotent, and only from a committed-but-not-yet-pulled state
  // (booked/signed). Never regress a job the tablet has already pulled or
  // surveyed, nor re-confirm one.
  if (job.status !== "booked" && job.status !== "signed") {
    return json(200, {
      status: job.status,
      alreadyConfirmed: job.status === "confirmed",
    });
  }

  // Mark ready for the assessor. The client-facing "you're all set" email is
  // sent earlier, when they sign the letter of engagement (see signwellWebhook).
  await setJobStatus(job.jobId, "confirmed");
  return json(200, { status: "confirmed" });
};
