// GET /zone?eircode=... — public zone lookup for the website's "Check Your
// Zone" widget. Reuses the routing-key LUT / A98 classifier (only A98
// geocodes). No token, no DB writes; throttled by the API default settings.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { computeQuotePricing } from "../shared/pricing";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const eircode = event.queryStringParameters?.eircode?.trim();
  if (!eircode) return json(400, { error: "eircode required" });

  const result = await computeQuotePricing(eircode);
  if (!result) return json(200, { serviceArea: "outside" });
  return json(200, { serviceArea: result.serviceArea, prices: result.prices });
};
