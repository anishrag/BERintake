// POST /jobs/{token}/quote — the client form saves its quote answers here.
// Stores the quote on the job and advances the status to `quoted`.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobByToken, isFormLocked, setQuote } from "../shared/jobs";
import { POST_WORKS_DISCOUNT } from "../shared/pricing";

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
  if (isFormLocked(job)) return json(409, { error: "completed" });

  const propertyType =
    typeof body.propertyType === "string" ? body.propertyType : undefined;
  const base = propertyType ? job.quotePrices?.[propertyType] : undefined;
  const price =
    typeof base === "number"
      ? job.postWorks
        ? Math.max(0, base - POST_WORKS_DISCOUNT)
        : base
      : undefined;
  const quote = {
    propertyType,
    purpose: typeof body.purpose === "string" ? body.purpose : undefined,
    bedrooms: typeof body.bedrooms === "number" ? body.bedrooms : undefined,
    // Server-authoritative — ignore any client-supplied price/serviceArea.
    serviceArea: job.serviceArea,
    price,
    quotedAt: new Date().toISOString(),
  };

  await setQuote(job.jobId, quote);
  return json(200, { status: "quoted", quote });
};
