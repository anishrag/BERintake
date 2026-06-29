// GET /jobs/{token} — public read used by the client-facing quote form to
// hydrate its current state. Returns only client-safe fields (no jobId,
// no source/partner data).

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobByToken } from "../shared/jobs";

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const token = event.pathParameters?.token;
  if (!token) return { statusCode: 400, body: "missing token" };

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") {
    return { statusCode: 404, body: "not found" };
  }

  const view = {
    status: job.status,
    client: job.client,
    quote: job.quote ?? null,
    booking: job.booking ?? null,
  };

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(view),
  };
};
