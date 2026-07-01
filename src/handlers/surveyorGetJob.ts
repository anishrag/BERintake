// GET /surveyor/jobs/{jobId} — one job's full seed, plus a short-lived presigned
// GET URL for its satellite image so the tablet can download it directly.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobById } from "../shared/jobs";
import { presignGet } from "../shared/s3";
import { isSurveyor } from "../shared/surveyorAuth";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if (!isSurveyor(event)) return json(401, { error: "unauthorized" });

  const jobId = event.pathParameters?.jobId;
  if (!jobId) return json(400, { error: "missing jobId" });

  const job = await getJobById(jobId);
  if (!job || job.status === "discarded") return json(404, { error: "not found" });

  const key = job.berSeed?.satelliteImageKey;
  const satelliteImageUrl = key ? await presignGet(key) : null;

  return json(200, {
    jobId: job.jobId,
    status: job.status,
    client: job.client,
    berSeed: job.berSeed ?? null,
    satelliteImageUrl,
  });
};
