// POST /surveyor/jobs/{jobId}/ber/complete — the tablet reports the finished
// assessment. The heavy data_json + photos were already uploaded to S3 via the
// presigned URLs; this records the pointer + summary and moves the job to
// `assessed`.
//
// Body: { ratingResult?: string, summary?: object }

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobById, setBerResult } from "../shared/jobs";
import { jobPrefix } from "../shared/s3";
import { isSurveyor } from "../shared/surveyorAuth";
import type { BerResult } from "../shared/types";
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
  if (!isSurveyor(event)) return json(401, { error: "unauthorized" });

  const jobId = event.pathParameters?.jobId;
  if (!jobId) return json(400, { error: "missing jobId" });

  const job = await getJobById(jobId);
  if (!job || job.status === "discarded") return json(404, { error: "not found" });

  let body: { ratingResult?: string; summary?: Record<string, unknown> };
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const ber: BerResult = {
    s3Prefix: jobPrefix(jobId),
    ratingResult:
      typeof body.ratingResult === "string" ? body.ratingResult : undefined,
    summary:
      body.summary && typeof body.summary === "object"
        ? body.summary
        : undefined,
    completedAt: new Date().toISOString(),
  };
  await setBerResult(jobId, ber);

  return json(200, { jobId, status: "assessed", ber });
};
