// QuickBooks Online connection: OAuth 2.0 with the rotating-refresh-token
// handling QBO requires (the newest refresh token MUST be persisted every
// refresh, or Intuit revokes the whole authorization). Tokens live in a
// single-row table.

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./db";

const TABLE = process.env.QB_AUTH_TABLE!;
const KEY = { id: "qb" };

const ENVN = process.env.QB_ENV || "sandbox";
export const QB_API_BASE =
  ENVN === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

export const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QB_SCOPE = "com.intuit.quickbooks.accounting";

const clientId = () => process.env.QB_CLIENT_ID || "";
const clientSecret = () => process.env.QB_CLIENT_SECRET || "";
const basicAuth = () =>
  Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");

interface QbAuth {
  accessToken?: string;
  refreshToken?: string;
  realmId?: string;
  accessExpiresAt?: number;
}

export async function getStoredAuth(): Promise<QbAuth | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: KEY }));
  return res.Item as QbAuth | undefined;
}

async function postToken(body: URLSearchParams): Promise<any> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "content-type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`qb token call failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Exchange the auth code from the OAuth callback for tokens; store them. */
export async function exchangeCode(
  code: string,
  redirectUri: string,
  realmId: string,
): Promise<void> {
  const data = await postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  );
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: KEY,
      UpdateExpression:
        "SET accessToken = :a, refreshToken = :r, realmId = :m, accessExpiresAt = :e",
      ExpressionAttributeValues: {
        ":a": data.access_token,
        ":r": data.refresh_token,
        ":m": realmId,
        ":e": Date.now() + (data.expires_in ?? 3600) * 1000,
      },
    }),
  );
}

async function refresh(auth: QbAuth): Promise<string> {
  const data = await postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken!,
    }),
  );
  // Persist the ROTATED refresh token immediately.
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: KEY,
      UpdateExpression:
        "SET accessToken = :a, refreshToken = :r, accessExpiresAt = :e",
      ExpressionAttributeValues: {
        ":a": data.access_token,
        ":r": data.refresh_token ?? auth.refreshToken,
        ":e": Date.now() + (data.expires_in ?? 3600) * 1000,
      },
    }),
  );
  return data.access_token;
}

export async function getAccessToken(): Promise<{ token: string; realmId: string }> {
  const auth = await getStoredAuth();
  if (!auth?.refreshToken || !auth.realmId) {
    throw new Error("QuickBooks not connected");
  }
  let token = auth.accessToken;
  if (!token || (auth.accessExpiresAt ?? 0) < Date.now() + 60_000) {
    token = await refresh(auth);
  }
  return { token: token!, realmId: auth.realmId };
}

/** Authenticated call against /v3/company/{realmId}{path}. */
export async function qbFetch(path: string, init?: RequestInit): Promise<Response> {
  const { token, realmId } = await getAccessToken();
  return fetch(`${QB_API_BASE}/v3/company/${realmId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  });
}
