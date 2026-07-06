// GET /qb/callback — Intuit redirects here after consent with ?code & ?realmId.
// Exchanges the code for tokens and stores them (incl. the company realmId).

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { exchangeCode } from "../shared/quickbooks";
import { hydrateSecrets } from "../shared/secrets";

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  const q = event.queryStringParameters || {};
  const code = q.code;
  const realmId = q.realmId;
  if (!code || !realmId) {
    return { statusCode: 400, body: "Missing code or realmId" };
  }

  const domain = event.requestContext.domainName;
  const redirectUri = `https://${domain}/qb/callback`;

  try {
    await exchangeCode(code, redirectUri, realmId);
  } catch (err) {
    console.error("qb callback failed", err);
    return { statusCode: 502, body: "QuickBooks connection failed. Check logs." };
  }

  return {
    statusCode: 200,
    headers: { "content-type": "text/html" },
    body: "<h2>QuickBooks connected ✅</h2><p>You can close this window.</p>",
  };
};
