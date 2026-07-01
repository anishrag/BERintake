// GET /surveyor/jobs?status=confirmed — the tablet lists BERs ready to assess.
// Defaults to `confirmed`; also accepts `pulled` (already imported, e.g. to
// re-sync). Returns each job's id, client, and berSeed so BER_APP can create a
// local `ber` row with id == jobId.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { findByStatus } from "../shared/jobs";
import { isSurveyor } from "../shared/surveyorAuth";
import type { JobStatus } from "../shared/types";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const ALLOWED: JobStatus[] = ["confirmed", "pulled"];

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if (!isSurveyor(event)) return json(401, { error: "unauthorized" });

  const requested = event.queryStringParameters?.status as
    | JobStatus
    | undefined;
  const status: JobStatus =
    requested && ALLOWED.includes(requested) ? requested : "confirmed";

  const jobs = await findByStatus(status);
  return json(200, {
    status,
    jobs: jobs.map((j) => ({
      jobId: j.jobId,
      status: j.status,
      client: j.client,
      berSeed: j.berSeed ?? null,
      createdAt: j.createdAt,
    })),
  });
};
