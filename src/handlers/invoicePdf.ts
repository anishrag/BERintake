// GET /jobs/{token}/invoice.pdf — streams the QuickBooks invoice PDF so the
// client form can show it inline. Generates the invoice first if needed.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobByToken } from "../shared/jobs";
import { ensureInvoiceForJob, getInvoicePdf } from "../shared/qbInvoice";
import { hydrateSecrets } from "../shared/secrets";
import { isSolarJob } from "../shared/solarPartner";

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  const token = event.pathParameters?.token;
  if (!token) return { statusCode: 400, body: "missing token" };

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") return { statusCode: 404, body: "not found" };
  // Solar-partner jobs: the invoice belongs to the partner — the client link
  // must not be able to read it.
  if (isSolarJob(job)) return { statusCode: 404, body: "not found" };

  try {
    const inv = await ensureInvoiceForJob(job);
    const pdf = await getInvoicePdf(inv.id);
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": "inline; filename=invoice.pdf",
      },
      body: pdf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err: any) {
    if (err?.message === "no-price") return { statusCode: 400, body: "no price set" };
    console.error("invoice pdf failed", err);
    return { statusCode: 502, body: "invoice unavailable" };
  }
};
