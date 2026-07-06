// GET /qb/connect — kicks off the one-time QuickBooks OAuth consent. Visit
// this URL in a browser once to authorize; Intuit redirects back to /qb/callback.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { AUTHORIZE_URL, QB_SCOPE } from "../shared/quickbooks";
import { hydrateSecrets } from "../shared/secrets";

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  const domain = event.requestContext.domainName;
  const redirectUri = `https://${domain}/qb/callback`;
  const params = new URLSearchParams({
    client_id: process.env.QB_CLIENT_ID || "",
    response_type: "code",
    scope: QB_SCOPE,
    redirect_uri: redirectUri,
    state: "qb-connect",
  });
  return {
    statusCode: 302,
    headers: { Location: `${AUTHORIZE_URL}?${params.toString()}` },
  };
};
