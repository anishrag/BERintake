// Scheduled sweep: nudge clients who booked but haven't completed payment +
// signing. Sends at most two reminders per job:
//   - "post24h"   ~24h after booking
//   - "daybefore" ~1 day before the appointment
// Runs every 12h; each reminder is sent once (tracked in remindersSent).

import { addReminderSent, findBooked } from "../shared/jobs";
import { sendReminderEmail } from "../shared/notify";

const HOUR = 60 * 60 * 1000;

export const handler = async (): Promise<{ reminded: number }> => {
  const now = Date.now();
  const jobs = await findBooked();

  let reminded = 0;
  for (const job of jobs) {
    const sent = job.remindersSent || [];
    const bookedAt = Date.parse(
      (job.booking as any)?.bookedAt || job.createdAt,
    );
    const apptStart = (job.booking as any)?.start
      ? Date.parse((job.booking as any).start)
      : null;

    // Don't chase an appointment that's already in the past.
    if (apptStart && apptStart < now) continue;

    // Pick at most one reminder per run; the day-before one takes priority.
    let kind: "daybefore" | "post24h" | null = null;
    if (
      !sent.includes("daybefore") &&
      apptStart &&
      apptStart - now <= 28 * HOUR
    ) {
      kind = "daybefore";
    } else if (!sent.includes("post24h") && now - bookedAt >= 24 * HOUR) {
      kind = "post24h";
    }
    if (!kind) continue;

    try {
      await sendReminderEmail(job, kind);
      await addReminderSent(job.jobId, kind);
      reminded++;
    } catch (err) {
      console.error("reminder failed for", job.jobId, err);
    }
  }
  console.log(`reminders sent: ${reminded} (of ${jobs.length} booked)`);
  return { reminded };
};
