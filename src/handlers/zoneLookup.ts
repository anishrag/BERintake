// GET /zone?eircode=... — public zone lookup for the website's "Check Your
// Zone" widget. Reuses the routing-key LUT / A98 classifier (only A98
// geocodes). No token, no DB writes; throttled by the API default settings.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { geocodeBudgetOk, getCachedZone, setCachedZone } from "../shared/geocache";
import { computeQuotePricing, needsGeocode } from "../shared/pricing";
import { allowRequest, clientIp } from "../shared/rateLimit";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  // Per-IP rate limit — this is public and each geocode costs money.
  if (!(await allowRequest(clientIp(event), "zone", 30, 60))) {
    return json(429, { error: "rate-limited" });
  }

  const eircode = event.queryStringParameters?.eircode?.trim();
  if (!eircode) return json(400, { error: "eircode required" });

  // Only the geocoded (A98) eircodes touch the cache / budget; routing-key
  // lookups are free, so they skip straight to computeQuotePricing.
  const geo = needsGeocode(eircode);
  if (geo) {
    const cached = await getCachedZone(eircode);
    if (cached) {
      return json(200, { serviceArea: cached.serviceArea, prices: cached.prices });
    }
    if (!(await geocodeBudgetOk())) {
      // Daily geocode budget exhausted — degrade rather than pay.
      return json(200, { serviceArea: "outside" });
    }
  }

  const result = await computeQuotePricing(eircode);
  if (!result) return json(200, { serviceArea: "outside" });
  if (geo) await setCachedZone(eircode, result);
  return json(200, { serviceArea: result.serviceArea, prices: result.prices });
};
