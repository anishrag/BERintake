// GET /jobs/{token} — public read used by the client-facing quote form to
// hydrate its current state. Returns only client-safe fields.
//
// Lazily computes and caches the zone-based pricing on first load so the
// form can show a real price without calling the website's Express server.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobByToken, setQuotePricing } from "../shared/jobs";
import { computeQuotePricing, pricesForArea } from "../shared/pricing";
import { hydrateSecrets } from "../shared/secrets";
import { isSolarJob, solarPartner } from "../shared/solarPartner";

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  const token = event.pathParameters?.token;
  if (!token) return { statusCode: 400, body: "missing token" };

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") {
    return { statusCode: 404, body: "not found" };
  }

  let serviceArea = job.serviceArea;
  let quotePrices = job.quotePrices;
  if (!quotePrices && job.client?.eircode) {
    const computed = await computeQuotePricing(job.client.eircode);
    if (computed) {
      // Real geocode — cache it.
      serviceArea = computed.serviceArea;
      quotePrices = computed.prices;
      await setQuotePricing(job.jobId, serviceArea, quotePrices);
    } else {
      // Geocoding unavailable — show a safe default but DON'T cache, so a
      // later load retries and can resolve the real zone.
      serviceArea = "outside";
      quotePrices = pricesForArea("outside");
    }
  }

  // Solar-partner jobs: the client pays nothing, so the form must never see a
  // price — strip the price map, the quoted price, and the (partner-billed)
  // invoice from the view. billTo/solarPartnerName drive the no-payment UI.
  const solar = isSolarJob(job);
  const quote = job.quote ? { ...job.quote } : null;
  if (solar && quote) delete quote.price;
  const view = {
    status: job.status,
    billTo: job.billTo ?? null,
    solarPartnerName: solar ? solarPartner().name : null,
    client: job.client,
    postWorks: job.postWorks ?? false,
    serviceArea: serviceArea ?? null,
    quotePrices: solar ? null : quotePrices ?? null,
    quote,
    booking: job.booking ?? null,
    keyDetails: job.keyDetails ?? null,
    invoice:
      job.invoice && !solar
        ? { docNumber: job.invoice.docNumber, total: job.invoice.total }
        : null,
    loe: job.loe ? { status: job.loe.status } : null,
  };

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(view),
  };
};
