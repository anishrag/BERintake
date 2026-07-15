// POST /surveyor/jobs — the tablet registers a cloud job for a BER created
// from scratch on-site (no intake funnel). Gives the BER a home in the jobs
// table + `bers/{jobId}/` so the push worker's presign stops 404ing and the
// survey data flows up like any intake-originated job.
//
// The tablet supplies the jobId (it IS the local ber.id — the 1:1 invariant
// the pull sync established). Idempotent: re-registering an existing job is a
// 200, so offline retries are harmless. Skips the whole client funnel: no
// email, no quote — the job lands directly as `pulled` with source "tablet".
//
// Body: { jobId: string, name?: string, address?: string, eircode?: string }

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, JOBS_TABLE } from "../shared/db";
import { getJobById } from "../shared/jobs";
import { newToken } from "../shared/ids";
import { isSurveyor } from "../shared/surveyorAuth";
import { hydrateSecrets } from "../shared/secrets";
import type { Job } from "../shared/types";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown): string =>
  typeof v === "string" ? v.trim() : "";

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  if (!isSurveyor(event)) return json(401, { error: "unauthorized" });

  let body: Record<string, unknown>;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const jobId = str(body.jobId).toLowerCase();
  if (!UUID_RE.test(jobId)) return json(400, { error: "jobId must be a UUID" });

  const existing = await getJobById(jobId);
  if (existing) return json(200, { jobId, existed: true });

  const now = new Date().toISOString();
  const address = str(body.address);
  const eircode = str(body.eircode);
  const job: Job = {
    jobId,
    token: newToken(),
    status: "pulled", // already being surveyed — the funnel doesn't apply
    source: "tablet",
    client: { name: str(body.name), email: "", eircode },
    // Same fallback as seedBerFromEircode: the address defaults to the eircode.
    ...(address || eircode
      ? { berSeed: { address: address || eircode, eircode } }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: JOBS_TABLE, Item: job }));

  return json(201, { jobId, existed: false });
};
