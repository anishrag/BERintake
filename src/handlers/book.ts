// POST /jobs/{token}/book {eventId} — books a calendar slot for this job:
// renames the calendar event and advances the job to `booked`.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { bookSlot, getEvent, isOpenSlot } from "../shared/calendar";
import { isHeldByOther, releaseHold } from "../shared/holds";
import {
  clearHold,
  getJobByToken,
  seedBerFromEircode,
  setBooking,
  setDetails,
} from "../shared/jobs";
import { sendOwnerNewBookingEmail } from "../shared/notify";
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
  const details =
    body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : undefined;

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") return json(404, { error: "not found" });

  // Idempotency: already booked — return the existing booking, no re-book.
  if (BOOKED_STATUSES.includes(job.status)) {
    return json(200, { status: job.status, booking: job.booking ?? null, alreadyBooked: true });
  }

  // Guard against double-booking a slot someone else took or holds.
  const calEvent = await getEvent(eventId);
  if (!calEvent) return json(404, { error: "slot-not-found" });
  if (!isOpenSlot(calEvent)) return json(409, { error: "slot-taken" });
  if (await isHeldByOther(eventId, job.jobId)) {
    return json(409, { error: "slot-taken" });
  }

  const summary = `BOOKED: ${job.client.name} | ${job.client.eircode} | ${job.client.email}`;
  try {
    await bookSlot(eventId, summary);
  } catch (err) {
    console.error("failed to book slot", err);
    return json(502, { error: "booking-failed" });
  }

  // Persist the submitted survey details before flipping to booked.
  if (details) await setDetails(job.jobId, details);

  const booking = {
    eventId,
    start: calEvent.start?.dateTime ?? calEvent.start?.date ?? null,
    end: calEvent.end?.dateTime ?? calEvent.end?.date ?? null,
    bookedAt: new Date().toISOString(),
  };
  await setBooking(job.jobId, booking);
  await releaseHold(eventId);
  await clearHold(job.jobId);

  // Tell the owner the booking details are in, with the invoice attached.
  // Best-effort — never fail a booking over a notification.
  try {
    await sendOwnerNewBookingEmail(job, details ?? job.keyDetails, booking.start);
  } catch (err) {
    console.error("owner new-booking email failed", err);
  }

  // Now that they've committed, geocode the eircode, grab the satellite image,
  // and fold the client's booking details into the seed for BER_APP. Best-effort
  // — never fail a confirmed booking over the seed. Use the just-submitted
  // details, falling back to any previously-saved draft.
  try {
    await seedBerFromEircode(job, details ?? job.keyDetails);
  } catch (err) {
    console.error(`berSeed generation failed for ${job.jobId}`, err);
  }

  return json(200, { status: "booked", booking });
};
