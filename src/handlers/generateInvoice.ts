// POST /jobs/{token}/invoice — create (or return) the QuickBooks invoice for
// this job. The client form calls this before showing the invoice + Pay.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobByToken } from "../shared/jobs";
import { ensureInvoiceForJob } from "../shared/qbInvoice";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const token = event.pathParameters?.token;
  if (!token) return json(400, { error: "missing token" });

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") return json(404, { error: "not found" });

  try {
    const inv = await ensureInvoiceForJob(job);
    return json(200, { invoiceId: inv.id, total: inv.total, docNumber: inv.docNumber });
  } catch (err: any) {
    if (err?.message === "no-price") return json(400, { error: "no-price" });
    console.error("invoice generation failed", err);
    return json(502, { error: "invoice-failed" });
  }
};
