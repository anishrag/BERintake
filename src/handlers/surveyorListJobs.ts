// GET /surveyor/jobs — the tablet lists BERs ready to assess. "Ready" means the
// client has committed to a slot (`booked`); signing the letter of engagement is
// a parallel, non-blocking step, so a job reaches the tablet as soon as it's
// booked, whether or not it's been signed/confirmed yet. Also includes `signed`
// (LoE signed) and `confirmed` (a job the website already advanced) so those
// still sync — every committed-but-not-yet-pulled state. An explicit ?status=
// filter (booked | signed | confirmed | pulled) narrows to one — e.g. `pulled`
// to re-sync an already-imported job. Returns each job's id, client, and
// berSeed so BER_APP can create a local `ber` row with id == jobId.

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

const ALLOWED: JobStatus[] = ["booked", "signed", "confirmed", "pulled"];
// Default set the tablet pulls: committed to a slot but not yet on a tablet.
const READY: JobStatus[] = ["booked", "signed", "confirmed"];

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if (!isSurveyor(event)) return json(401, { error: "unauthorized" });

  const requested = event.queryStringParameters?.status as
    | JobStatus
    | undefined;
  const filtered = requested && ALLOWED.includes(requested) ? requested : null;
  const statuses: JobStatus[] = filtered ? [filtered] : READY;

  const jobs = (await Promise.all(statuses.map(findByStatus))).flat();
  return json(200, {
    status: filtered ?? "ready",
    jobs: jobs.map((j) => ({
      jobId: j.jobId,
      status: j.status,
      client: j.client,
      berSeed: j.berSeed ?? null,
      createdAt: j.createdAt,
    })),
  });
};
