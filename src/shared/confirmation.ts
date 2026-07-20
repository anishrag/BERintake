// Owner-confirmation gate. Some client-driven bookings must not be allowed to
// commit anything (a QuickBooks invoice, a SignWell Letter of Engagement, or a
// calendar booking) until the owner has manually confirmed them:
//
//   • post-works  — the client ticked "my pre-works BER was done by Cannygreen",
//                   which we can't verify automatically (and which discounts the
//                   price). We must check it against our own records first.
//   • outside-zone — the property geocodes outside our service areas.
//
// Handlers call pendingConfirmation() at every commit point. When it returns
// reasons, they call requestOwnerConfirmation() (idempotent — pings the owner on
// Telegram once) and refuse the action. The owner confirms/rejects from Telegram
// (see telegramWebhook.ts), which calls approveBooking()/rejectBooking() here.

import { escapeHtml } from "./html";
import { setConfirmGate, setJobStatus } from "./jobs";
import {
  sendBookingConfirmedEmail,
  sendBookingRejectedEmail,
} from "./notify";
import { computeQuotePricing } from "./pricing";
import { notifyOwner } from "./telegram";
import type { ConfirmReason, Job } from "./types";

// Owner-created / partner-arranged jobs are already vetted by the owner (they
// set them up on Telegram, or a partner deal covers them), so they never gate —
// only self-serve web/partner-form bookings the owner hasn't seen do.
function ownerInitiated(job: Job): boolean {
  return (
    job.source === "telegram" ||
    !!job.billTo ||
    typeof job.agreedPrice === "number"
  );
}

/**
 * The raw reasons this booking needs the owner's confirmation, ignoring any
 * decision already made. Empty when the booking may proceed freely.
 */
export async function confirmationReasons(job: Job): Promise<ConfirmReason[]> {
  if (ownerInitiated(job)) return [];
  const reasons: ConfirmReason[] = [];
  if (job.postWorks) reasons.push("post-works");

  // serviceArea is normally cached on the job by getJob's first load; fall back
  // to a live compute so an outside-zone booking can never slip through ungated.
  let area = job.serviceArea;
  if (!area && job.client?.eircode) {
    const computed = await computeQuotePricing(job.client.eircode);
    area = computed?.serviceArea;
  }
  if (area === "outside") reasons.push("outside-zone");
  return reasons;
}

/**
 * The reasons still pending — [] once the owner has approved. Handlers block
 * whenever this is non-empty.
 */
export async function pendingConfirmation(job: Job): Promise<ConfirmReason[]> {
  if (job.confirmGate?.status === "approved") return [];
  return confirmationReasons(job);
}

// One-line reason, owner-facing (Telegram).
function ownerReasonLine(reason: ConfirmReason): string {
  switch (reason) {
    case "post-works":
      return "• <b>Post-works BER</b> claimed — check we did their pre-works BER (&lt;6 months).";
    case "outside-zone":
      return "• <b>Outside your service zones</b> — the address geocodes outside your areas.";
  }
}

/**
 * Ping the owner on Telegram to confirm this booking, and mark the gate
 * pending. Idempotent: a gate that already exists (pending/approved/rejected)
 * is left untouched, so repeated blocked attempts don't spam the owner.
 */
export async function requestOwnerConfirmation(
  job: Job,
  reasons: ConfirmReason[],
): Promise<void> {
  if (job.confirmGate || reasons.length === 0) return;

  await setConfirmGate(job.jobId, {
    reasons,
    status: "pending",
    notifiedAt: new Date().toISOString(),
  });

  const name = job.client.name || "(name TBC)";
  await notifyOwner(
    `🔔 <b>Booking needs your confirmation</b>\n\n` +
      `<b>${escapeHtml(name)}</b>\n` +
      `✉️ ${escapeHtml(job.client.email)}\n` +
      `📞 ${escapeHtml(job.client.phone ?? "no phone")}\n` +
      `📍 ${escapeHtml(job.client.eircode || "no eircode")}\n\n` +
      reasons.map(ownerReasonLine).join("\n") +
      `\n\nNothing has been booked or invoiced. Confirm to let them proceed, or reject.`,
    {
      inline_keyboard: [
        [
          { text: "✅ Confirm", callback_data: `cbook:${job.jobId}` },
          { text: "🗑 Reject", callback_data: `rbook:${job.jobId}` },
        ],
      ],
    },
  );
}

/**
 * The owner has confirmed the booking: mark the gate approved and email the
 * client a link to finish. Their saved form details resume the booking flow.
 */
export async function approveBooking(job: Job): Promise<void> {
  await setConfirmGate(job.jobId, {
    reasons: job.confirmGate?.reasons ?? (await confirmationReasons(job)),
    status: "approved",
    notifiedAt: job.confirmGate?.notifiedAt ?? new Date().toISOString(),
    decidedAt: new Date().toISOString(),
  });
  await sendBookingConfirmedEmail(job);
}

/**
 * The owner has rejected the booking: discard the job (the link stops working)
 * and email the client a polite decline explaining why.
 */
export async function rejectBooking(job: Job): Promise<void> {
  const reasons = job.confirmGate?.reasons ?? (await confirmationReasons(job));
  await setConfirmGate(job.jobId, {
    reasons,
    status: "rejected",
    notifiedAt: job.confirmGate?.notifiedAt ?? new Date().toISOString(),
    decidedAt: new Date().toISOString(),
  });
  await setJobStatus(job.jobId, "discarded");
  await sendBookingRejectedEmail(job, reasons);
}
