// POST /surveyor/jobs/{jobId}/ber/presign — mint short-lived presigned PUT URLs
// the tablet uses to upload the finished BER: `data.json` and any photos. The
// tablet committing to upload is our signal the job has been pulled, so we
// advance `confirmed → pulled` here.
//
// Body: { photos?: [{ id: string, contentType?: string }] }
// Returns: { prefix, dataUrl, photoUrls: { [id]: url } }

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobById, setJobStatus } from "../shared/jobs";
import { jobPrefix, presignPut } from "../shared/s3";
import { isSurveyor } from "../shared/surveyorAuth";
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

  let body: { photos?: { id: string; contentType?: string }[] };
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const prefix = jobPrefix(jobId);
  const dataUrl = await presignPut(`${prefix}data.json`, "application/json");

  const photoUrls: Record<string, string> = {};
  for (const p of body.photos ?? []) {
    if (!p?.id || typeof p.id !== "string") continue;
    // Constrain the id to a safe filename segment.
    const safeId = p.id.replace(/[^A-Za-z0-9._-]/g, "_");
    photoUrls[p.id] = await presignPut(
      `${prefix}photos/${safeId}.jpg`,
      p.contentType ?? "image/jpeg",
    );
  }

  // First upload intent — mark it pulled (don't regress an already-surveyed job).
  if (
    job.status === "booked" ||
    job.status === "signed" ||
    job.status === "confirmed"
  ) {
    await setJobStatus(jobId, "pulled");
  }

  return json(200, { prefix, dataUrl, photoUrls });
};
