// GET /qb/status — quick check that the connection works (fetches the company
// name from QuickBooks). Used to verify setup before building on it.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getStoredAuth, qbFetch } from "../shared/quickbooks";

export const handler = async (): Promise<APIGatewayProxyResultV2> => {
  const auth = await getStoredAuth();
  if (!auth?.refreshToken || !auth.realmId) {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connected: false }),
    };
  }

  try {
    const res = await qbFetch(`/companyinfo/${auth.realmId}`);
    if (!res.ok) {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connected: false, error: `status ${res.status}` }),
      };
    }
    const data: any = await res.json();
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connected: true,
        company: data?.CompanyInfo?.CompanyName ?? null,
        realmId: auth.realmId,
      }),
    };
  } catch (err) {
    console.error("qb status failed", err);
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connected: false, error: "call-failed" }),
    };
  }
};
