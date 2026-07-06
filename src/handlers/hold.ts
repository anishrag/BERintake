// POST /jobs/{token}/hold {eventId} — reserve a slot for this job while they
// fill the booking form (up to 24h). Releases the job's previous hold first.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getEvent, isOpenSlot } from "../shared/calendar";
import { placeHold } from "../shared/holds";
import { getJobByToken, setHold } from "../shared/jobs";
import { hydrateSecrets } from "../shared/secrets";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const BOOKED_STATUSES = ["booked", "paid", "signed", "confirmed", "pulled"];

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  const token = event.pathParameters?.token;
  if (!token) return json(400, { error: "missing token" });

  let body: Record<string, unknown>;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  const eventId = typeof body.eventId === "string" ? body.eventId : "";
  if (!eventId) return json(400, { error: "eventId required" });

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") return json(404, { error: "not found" });
  if (BOOKED_STATUSES.includes(job.status)) {
    return json(409, { error: "already-booked" });
  }

  // Don't hold a slot that's already been booked on the calendar.
  const calEvent = await getEvent(eventId);
  if (!calEvent) return json(404, { error: "slot-not-found" });
  if (!isOpenSlot(calEvent)) return json(409, { error: "slot-taken" });

  const { ok, holdUntil } = await placeHold(eventId, job.jobId, job.hold?.eventId);
  if (!ok) return json(409, { error: "slot-taken" });

  await setHold(job.jobId, eventId, holdUntil!);
  return json(200, { held: true, holdUntil });
};
