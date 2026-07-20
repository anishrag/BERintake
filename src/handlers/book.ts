// POST /jobs/{token}/book {eventId} — books a calendar slot for this job:
// renames the calendar event and advances the job to `booked`.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { bookSlot, getEvent, isOpenSlot } from "../shared/calendar";
import {
  pendingConfirmation,
  requestOwnerConfirmation,
} from "../shared/confirmation";
import { isHeldByOther, releaseHold } from "../shared/holds";
import {
  clearHold,
  getJobById,
  getJobByToken,
  seedBerFromEircode,
  setBooking,
  setDetails,
} from "../shared/jobs";
import {
  sendOwnerNewBookingEmail,
  sendSolarPartnerInvoiceEmail,
} from "../shared/notify";
import { isSolarJob } from "../shared/solarPartner";
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

  // Owner-confirmation gate: a post-works or outside-zone booking must be
  // confirmed by the owner before anything commits. Don't book the slot, mint
  // an invoice, or seed the tablet — just save the just-submitted details (so
  // they resume when the owner confirms) and ping the owner once.
  const reasons = await pendingConfirmation(job);
  if (reasons.length) {
    if (details) {
      await setDetails(job.jobId, details, { backfillEircode: !job.client.eircode });
    }
    await requestOwnerConfirmation(job, reasons);
    return json(409, { error: "needs-confirmation", reasons });
  }

  // Guard against double-booking a slot someone else took or holds.
  const calEvent = await getEvent(eventId);
  if (!calEvent) return json(404, { error: "slot-not-found" });
  if (!isOpenSlot(calEvent)) return json(409, { error: "slot-taken" });
  if (await isHeldByOther(eventId, job.jobId)) {
    return json(409, { error: "slot-taken" });
  }

  // The job may have been created without a name/eircode (Auctioneera) — the
  // just-submitted form is the freshest source for the calendar summary.
  const dName = (typeof details?.name === "string" && details.name.trim()) || job.client.name;
  const dEircode =
    (typeof details?.eircode === "string" && details.eircode.trim()) || job.client.eircode;
  const summary = `BOOKED: ${dName} | ${dEircode} | ${job.client.email}`;
  try {
    await bookSlot(eventId, summary);
  } catch (err) {
    console.error("failed to book slot", err);
    return json(502, { error: "booking-failed" });
  }

  // Persist the submitted survey details before flipping to booked. Backfill
  // the client eircode only when the job was created without one.
  if (details) {
    await setDetails(job.jobId, details, {
      backfillEircode: !job.client.eircode,
    });
  }

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
  // Re-fetch first so the invoice (minted inside the email) carries the
  // backfilled name/eircode rather than the pre-form record. Best-effort —
  // never fail a booking over a notification.
  const fresh = (await getJobById(job.jobId)) ?? job;
  try {
    await sendOwnerNewBookingEmail(fresh, details ?? fresh.keyDetails, booking.start);
  } catch (err) {
    console.error("owner new-booking email failed", err);
  }

  // Solar-partner job: the client pays nothing — invoice the partner now that
  // the slot is committed, with the PDF attached. Re-fetch the job first: the
  // owner email above may have just minted the invoice, and a stale object
  // (no invoice.id) would create a duplicate in QuickBooks. Best-effort as
  // well; the owner email already carries the same invoice as a fallback.
  if (isSolarJob(job)) {
    try {
      const withInvoice = (await getJobById(job.jobId)) ?? fresh;
      await sendSolarPartnerInvoiceEmail(withInvoice);
    } catch (err) {
      console.error("solar partner invoice email failed", err);
    }
  }

  // Now that they've committed, geocode the eircode, grab the satellite image,
  // and fold the client's booking details into the seed for BER_APP. Best-effort
  // — never fail a confirmed booking over the seed. Use the just-submitted
  // details, falling back to any previously-saved draft.
  try {
    await seedBerFromEircode(fresh, details ?? fresh.keyDetails);
  } catch (err) {
    console.error(`berSeed generation failed for ${job.jobId}`, err);
  }

  return json(200, { status: "booked", booking });
};
