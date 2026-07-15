// GET /pricing — public price table for the website. The site renders its
// pricing from this at runtime (bundled snapshot only as offline fallback),
// making the table in shared/pricing.ts the single source of truth: a price
// change is one edit + one backend deploy, no website redeploy.

import type { APIGatewayProxyResultV2 } from "aws-lambda";
import { POST_WORKS_DISCOUNT, pricing } from "../shared/pricing";

export const handler = async (): Promise<APIGatewayProxyResultV2> => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
    // Static config: let browsers cache briefly so repeat page views are free.
    "cache-control": "public, max-age=300",
  },
  body: JSON.stringify({ pricing, postWorksDiscount: POST_WORKS_DISCOUNT }),
});
