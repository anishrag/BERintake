// POST /jobs/{token}/details — save the in-progress booking details (a draft,
// does NOT book), so the client can close the form and resume later via the
// same link. With {email:true}, also emails them a link back to the form.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { sendEmail } from "../shared/email";
import {
  sendOwnerNewBookingEmail,
  sendSolarPartnerInvoiceEmail,
} from "../shared/notify";
import { escapeHtml } from "../shared/html";
import {
  addSentEmail,
  clientLink,
  getJobByToken,
  isFormLocked,
  seedBerFromEircode,
  setBooking,
  setDetails,
  setQuote,
} from "../shared/jobs";
import { isSolarJob, solarPriceFor } from "../shared/solarPartner";
import { hydrateSecrets } from "../shared/secrets";

const PROPERTY_TYPES = ["apartment", "small-house", "large-house"];

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

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

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") return json(404, { error: "not found" });
  if (isFormLocked(job)) return json(409, { error: "completed" });

  const details =
    body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : {};

  // A pre-agreed solar booking (/newsolar_arranged) has no quote yet — the
  // client's property type is what prices the partner invoice, so completing
  // the form requires it. Record it (with the partner-table price) BEFORE the
  // prebooked→booked flip below, so the invoice can be minted right after.
  const solarNeedsQuote =
    isSolarJob(job) && job.status === "prebooked" && !job.quote;
  if (solarNeedsQuote) {
    const propertyType =
      typeof details.propertyType === "string" &&
      PROPERTY_TYPES.includes(details.propertyType)
        ? details.propertyType
        : undefined;
    if (!propertyType) return json(400, { error: "property-type-required" });
    await setQuote(job.jobId, {
      propertyType,
      serviceArea: job.serviceArea,
      price: solarPriceFor(job.serviceArea, propertyType),
      quotedAt: new Date().toISOString(),
    });
  }

  await setDetails(job.jobId, details, {
    backfillEircode: !job.client.eircode,
  });

  // Keep the assessor's seed in step with the client's real address/property
  // details. A pre-agreed booking's initial seed only had the eircode (the
  // form isn't filled yet at booking), so refresh it once the client provides
  // an address. Only for committed bookings (a draft has no seed yet).
  const committed = ["prebooked", "booked", "signed", "confirmed", "pulled"].includes(
    job.status,
  );
  if (committed && typeof details.address === "string" && details.address.trim()) {
    try {
      await seedBerFromEircode(job, details);
    } catch (err) {
      console.error("berSeed refresh failed for", job.jobId, err);
    }
  }

  // A pre-agreed (Telegram) booking becomes a real `booked` once the client has
  // filled in the form. Reset bookedAt so the LoE nudge times from now (real
  // engagement), not from when the owner created the pre-agreed slot.
  if (job.status === "prebooked") {
    const booking = (job.booking as Record<string, unknown> | undefined) ?? {};
    await setBooking(
      job.jobId,
      { ...booking, bookedAt: new Date().toISOString() },
      "booked",
    );
    // Owner notification: the pre-agreed client has now completed the form.
    // Reload so it carries the backfilled name + saved details.
    try {
      const fresh = (await getJobByToken(token)) ?? job;
      await sendOwnerNewBookingEmail(fresh, details, booking.start as string | undefined);
    } catch (err) {
      console.error("owner email (prebooked->booked) failed", err);
    }

    // Pre-agreed solar booking: the form is complete, so the partner invoice
    // can now be priced (property type + zone) — send it. Re-fetch first: the
    // owner email above may have just minted the invoice, and a stale object
    // would create a duplicate in QuickBooks. Best-effort — the owner email
    // already carries the same invoice as a fallback.
    if (isSolarJob(job)) {
      try {
        const fresh = (await getJobByToken(token)) ?? job;
        await sendSolarPartnerInvoiceEmail(fresh);
      } catch (err) {
        console.error("solar partner invoice email failed", err);
      }
    }
  }

  let emailed = false;
  // Cap the resume email to once per job — the details always save (above), but
  // the email only sends once, so /details can't be used to bomb an inbox.
  const alreadyEmailed = job.sentEmails?.includes("save_for_later");
  if (body.email === true && !alreadyEmailed) {
    const name = job.client.name.split(" ")[0];
    const link = clientLink(job.token);
    try {
      await sendEmail({
        to: job.client.email,
        subject: "Cannygreen BER - Finish booking your assessment",
        text: `Hi ${name},

Your details are saved. When you're ready, open this link to finish booking your BER assessment:
${link}

Note: your assessment is not booked until you submit the form.

Kind regards,
Anish`,
        html: `<p>Hi ${escapeHtml(name)},</p>
<p>Your details are saved. When you're ready, open this link to finish booking your BER assessment:<br>
<a href="${link}">${link}</a></p>
<p><em>Note: your assessment is not booked until you submit the form.</em></p>
<p>Kind regards,<br>Anish</p>`,
      });
      emailed = true;
      // This "finish booking" link supersedes the deferred quote email, so
      // record it — the sweep won't also send the quote nudge (#1).
      await addSentEmail(job.jobId, "save_for_later");
    } catch (err) {
      console.error("failed to send resume email", err);
    }
  }

  return json(200, { saved: true, emailed });
};
