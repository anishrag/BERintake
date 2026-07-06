// GET /surveyor/jobs/{jobId} — one job's full seed, plus a short-lived presigned
// GET URL for its satellite image so the tablet can download it directly.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobById, seedFromDetails } from "../shared/jobs";
import { presignGet } from "../shared/s3";
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

  const key = job.berSeed?.satelliteImageKey;
  const satelliteImageUrl = key ? await presignGet(key) : null;

  // Fold the client's latest booking-form answers into the seed. Details entered
  // AFTER booking (e.g. a Telegram-booked job whose client fills the web form
  // later) live in `keyDetails`, not the seed written at booking — merge them so
  // the tablet's Key Details screen gets them. Fresh client detail fields win;
  // the seed's geocoded address + coords + satellite key are preserved.
  const fromDetails = seedFromDetails(job.keyDetails);
  const seed = job.berSeed;
  const berSeed =
    seed || Object.keys(fromDetails).length
      ? {
          ...seed,
          ...fromDetails,
          address: seed?.address ?? fromDetails.address ?? job.client.eircode,
          eircode: seed?.eircode ?? job.client.eircode,
        }
      : null;

  return json(200, {
    jobId: job.jobId,
    status: job.status,
    client: job.client,
    berSeed,
    satelliteImageUrl,
  });
};
