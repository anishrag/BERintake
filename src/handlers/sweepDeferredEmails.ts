// Scheduled sweep: send the funnel's deferred emails only if the client hasn't
// already moved on to the next stage. Runs every couple of minutes.
//
//   #1 quote      — 1h after the client got their quote (status `quoted`),
//                   unless they've since booked (status left `quoted`).
//   #2 loe_nudge  — 10min after booking (status `booked`), unless the letter
//                   of engagement is already signed (loe.status === completed).
//
// Cancellation is implicit: an advanced job either drops out of the status
// query (#1) or fails the loe check (#2). Each email is sent at most once,
// tracked in `sentEmails`.

import { addSentEmail, findByStatus } from "../shared/jobs";
import { sendLoeNudgeEmail, sendQuoteEmail } from "../shared/notify";

const MIN = 60 * 1000;
const QUOTE_DELAY = 60 * MIN; // 1 hour
const LOE_DELAY = 10 * MIN; // 10 minutes

export const handler = async (): Promise<{ quote: number; loe: number }> => {
  const now = Date.now();
  let quote = 0;
  let loe = 0;

  // #1 — quote email for jobs that got a quote but haven't booked. Skipped if
  // they clicked "save for later" (that email already gave them a resume link).
  for (const job of await findByStatus("quoted")) {
    if (job.sentEmails?.includes("quote")) continue;
    if (job.sentEmails?.includes("save_for_later")) continue;
    const quotedAt = Date.parse((job.quote as any)?.quotedAt ?? job.updatedAt);
    if (!Number.isFinite(quotedAt) || now - quotedAt < QUOTE_DELAY) continue;
    try {
      await sendQuoteEmail(job);
      await addSentEmail(job.jobId, "quote");
      quote++;
    } catch (err) {
      console.error("quote email failed for", job.jobId, err);
    }
  }

  // #2 — letter-of-engagement nudge for booked jobs not yet signed.
  for (const job of await findByStatus("booked")) {
    if (job.sentEmails?.includes("loe_nudge")) continue;
    if (job.loe?.status === "completed") continue;
    const bookedAt = Date.parse((job.booking as any)?.bookedAt ?? job.updatedAt);
    if (!Number.isFinite(bookedAt) || now - bookedAt < LOE_DELAY) continue;
    try {
      await sendLoeNudgeEmail(job);
      await addSentEmail(job.jobId, "loe_nudge");
      loe++;
    } catch (err) {
      console.error("loe nudge failed for", job.jobId, err);
    }
  }

  console.log(`deferred emails sent — quote:${quote} loe_nudge:${loe}`);
  return { quote, loe };
};
