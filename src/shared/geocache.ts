// Geocode cost controls for the public /zone lookup:
//  - cache eircode -> zone result (so repeat lookups are free);
//  - a per-day geocode budget (circuit breaker) that hard-caps the Google bill
//    no matter how many distinct eircodes an attacker enumerates.
// Both live in their own TTL'd table. Everything is best-effort — a failure
// falls back to "just geocode" rather than breaking the lookup.

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./db";
import type { HouseType, ServiceArea } from "./pricing";

const TABLE = process.env.GEOCODE_CACHE_TABLE;
const DAILY_LIMIT = Number(process.env.GEOCODE_DAILY_LIMIT || "1000");
const CACHE_TTL_SEC = 90 * 24 * 60 * 60; // 90 days

export interface ZoneResult {
  serviceArea: ServiceArea;
  prices: Record<HouseType, number>;
}

const norm = (eircode: string) => eircode.replace(/\s+/g, "").toUpperCase();

export async function getCachedZone(
  eircode: string,
): Promise<ZoneResult | undefined> {
  if (!TABLE) return undefined;
  try {
    const res = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { id: `zone:${norm(eircode)}` } }),
    );
    if (res.Item?.serviceArea && res.Item?.prices) {
      return { serviceArea: res.Item.serviceArea, prices: res.Item.prices };
    }
  } catch (err) {
    console.error("geocache get failed", err);
  }
  return undefined;
}

export async function setCachedZone(
  eircode: string,
  result: ZoneResult,
): Promise<void> {
  if (!TABLE) return;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id: `zone:${norm(eircode)}` },
        UpdateExpression:
          "SET serviceArea = :a, prices = :p, expiresAt = :exp",
        ExpressionAttributeValues: {
          ":a": result.serviceArea,
          ":p": result.prices,
          ":exp": Math.floor(Date.now() / 1000) + CACHE_TTL_SEC,
        },
      }),
    );
  } catch (err) {
    console.error("geocache put failed", err);
  }
}

/**
 * Count one geocode against today's budget. Returns true if still within
 * GEOCODE_DAILY_LIMIT (so the caller may geocode), false once the cap is hit.
 * Fails open (returns true) on any error.
 */
export async function geocodeBudgetOk(): Promise<boolean> {
  if (!TABLE) return true;
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id: `count:${day}` },
        UpdateExpression:
          "SET expiresAt = if_not_exists(expiresAt, :exp) ADD #n :one",
        ExpressionAttributeNames: { "#n": "count" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":exp": Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(res.Attributes?.count ?? 1) <= DAILY_LIMIT;
  } catch (err) {
    console.error("geocode budget check failed (allowing)", err);
    return true;
  }
}
