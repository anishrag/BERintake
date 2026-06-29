// POST /jobs/{token}/email-quote — saves the client's quote selection and
// emails them a copy with a link back to continue booking.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { sendEmail } from "../shared/email";
import { clientLink, getJobByToken, setQuote } from "../shared/jobs";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const PROPERTY_LABELS: Record<string, string> = {
  apartment: "Apartment",
  "small-house": "House (under 200 m²)",
  "large-house": "House (over 200 m²)",
};

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const token = event.pathParameters?.token;
  if (!token) return json(400, { error: "missing token" });

  let body: Record<string, unknown>;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") {
    return json(404, { error: "not found" });
  }

  const propertyType =
    typeof body.propertyType === "string" ? body.propertyType : undefined;
  const price = typeof body.price === "number" ? body.price : undefined;

  // Persist the selection so it isn't lost.
  await setQuote(job.jobId, {
    propertyType,
    price,
    quotedAt: new Date().toISOString(),
  });

  const name = job.client.name.split(" ")[0];
  const propLabel = propertyType
    ? PROPERTY_LABELS[propertyType] ?? propertyType
    : "your property";
  const priceLine =
    price != null
      ? `Your BER assessment quote is €${price} for ${propLabel} at ${job.client.eircode}.`
      : `We'll confirm the exact price for ${propLabel} at ${job.client.eircode} shortly.`;
  const link = clientLink(job.token);

  const text = `Hi ${name},

Thanks for your enquiry with Cannygreen.

${priceLine}

When you're ready to book your assessment, just open this link:
${link}

Kind regards,
Anish`;

  const html = `<p>Hi ${name},</p>
<p>Thanks for your enquiry with Cannygreen.</p>
<p><strong>${priceLine}</strong></p>
<p>When you're ready to book your assessment, just open this link:<br>
<a href="${link}">${link}</a></p>
<p>Kind regards,<br>Anish</p>`;

  try {
    await sendEmail({
      to: job.client.email,
      subject: "Your BER Assessment Quote — Cannygreen",
      text,
      html,
    });
  } catch (err) {
    console.error("failed to send quote email", err);
    return json(502, { error: "email-failed" });
  }

  return json(200, { emailed: true, to: job.client.email });
};
