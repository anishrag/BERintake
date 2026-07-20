// POST /surveyor/jobs/{jobId}/ber/request-details — the tablet's "Follow ups"
// tab sends the assessor-composed email asking the client for the outstanding
// details/documents. We email the client and move the job to
// `details_requested`.
//
// Body: { subject: string, body: string } — the finished email, composed +
// edited on the tablet (it holds the request catalogue and fills the draft).
//
// NOTE (temporary): while this is being trialled the recipient is overridden to
// the assessor's own inbox; the real client address is flagged in the subject
// (same convention as email.ts's TEST_EMAIL_OVERRIDE). Remove the override to
// go live to clients.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { sendEmail } from "../shared/email";
import { getJobById, setJobStatus } from "../shared/jobs";
import { hydrateSecrets } from "../shared/secrets";
import { isSurveyor } from "../shared/surveyorAuth";

// Temporary trial override — send follow-up requests here, not to the client.
const OVERRIDE_RECIPIENT = "anishrag@gmail.com";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Escape + wrap the plain-text draft into simple HTML: blank lines become
// paragraph breaks, single newlines become <br>.
function textToHtml(text: string): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  if (!isSurveyor(event)) return json(401, { error: "unauthorized" });

  const jobId = event.pathParameters?.jobId;
  if (!jobId) return json(400, { error: "missing jobId" });

  const job = await getJobById(jobId);
  if (!job || job.status === "discarded")
    return json(404, { error: "not found" });

  let parsed: { subject?: string; body?: string };
  try {
    parsed = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const subject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
  const body = typeof parsed.body === "string" ? parsed.body : "";
  if (!subject || !body.trim())
    return json(400, { error: "missing subject or body" });

  const clientEmail = job.client?.email;
  // Trial: redirect to the assessor, flag the intended client in the subject.
  const to = OVERRIDE_RECIPIENT;
  const flaggedSubject = clientEmail
    ? `[→ ${clientEmail}] ${subject}`
    : subject;

  await sendEmail({
    to,
    subject: flaggedSubject,
    text: body,
    html: textToHtml(body),
  });

  await setJobStatus(jobId, "details_requested");

  return json(200, { jobId, status: "details_requested", to });
};
