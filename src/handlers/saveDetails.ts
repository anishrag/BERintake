// POST /jobs/{token}/details — save the in-progress booking details (a draft,
// does NOT book), so the client can close the form and resume later via the
// same link. With {email:true}, also emails them a link back to the form.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { sendEmail } from "../shared/email";
import { escapeHtml } from "../shared/html";
import {
  addSentEmail,
  clientLink,
  getJobByToken,
  isFormLocked,
  setDetails,
} from "../shared/jobs";
import { hydrateSecrets } from "../shared/secrets";

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
  await setDetails(job.jobId, details);

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
