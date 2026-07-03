// Per-IP rate limiting via a DynamoDB counter (one item per IP + fixed window,
// TTL'd so it self-cleans). Best-effort: any error (or missing IP/table) allows
// the request — a broken limiter must never take the site down.

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./db";

const TABLE = process.env.RATE_LIMIT_TABLE;

/**
 * @returns true if allowed, false if `ip` has exceeded `limit` requests for
 * `bucket` within the current `windowSec` window.
 */
export async function allowRequest(
  ip: string | undefined,
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  if (!ip || !TABLE) return true;
  const now = Date.now();
  const window = Math.floor(now / (windowSec * 1000));
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id: `${bucket}:${ip}:${window}` },
        UpdateExpression:
          "SET expiresAt = if_not_exists(expiresAt, :exp) ADD #n :one",
        ExpressionAttributeNames: { "#n": "count" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":exp": Math.floor(now / 1000) + windowSec + 60,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(res.Attributes?.count ?? 1) <= limit;
  } catch (err) {
    console.error("rate limit check failed (allowing)", err);
    return true;
  }
}

/** Client IP from an API Gateway v2 (HTTP API) event. */
export function clientIp(event: {
  requestContext?: { http?: { sourceIp?: string } };
}): string | undefined {
  return event.requestContext?.http?.sourceIp;
}
