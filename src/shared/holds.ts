// Tentative slot reservations. A hold reserves a calendar slot for one job for
// up to 24h while they fill the booking form, so no one else can book it. Holds
// live in their own table with a TTL, so expired ones clean themselves up — a
// slot frees automatically if the form is never submitted.

import { DeleteCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./db";

const HOLDS_TABLE = process.env.HOLDS_TABLE!;
const HOLD_MS = 24 * 60 * 60 * 1000;

export async function placeHold(
  eventId: string,
  jobId: string,
  prevEventId?: string,
): Promise<{ ok: boolean; holdUntil?: string }> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const holdUntil = new Date(now + HOLD_MS).toISOString();

  // Release this job's previous hold (they picked a different slot).
  if (prevEventId && prevEventId !== eventId) {
    await ddb.send(
      new DeleteCommand({ TableName: HOLDS_TABLE, Key: { eventId: prevEventId } }),
    );
  }

  try {
    await ddb.send(
      new PutCommand({
        TableName: HOLDS_TABLE,
        Item: {
          eventId,
          jobId,
          holdUntil,
          expiresAt: Math.floor((now + HOLD_MS) / 1000), // TTL
        },
        // Take it only if free, expired, or already ours.
        ConditionExpression:
          "attribute_not_exists(eventId) OR holdUntil < :now OR jobId = :j",
        ExpressionAttributeValues: { ":now": nowIso, ":j": jobId },
      }),
    );
    return { ok: true, holdUntil };
  } catch (e: any) {
    if (e.name === "ConditionalCheckFailedException") return { ok: false };
    throw e;
  }
}

export async function releaseHold(eventId: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({ TableName: HOLDS_TABLE, Key: { eventId } }),
  );
}

/** Event ids currently held by a DIFFERENT job (so they're hidden from this one). */
export async function heldByOthers(jobId: string): Promise<Set<string>> {
  const nowIso = new Date().toISOString();
  const res = await ddb.send(new ScanCommand({ TableName: HOLDS_TABLE }));
  const set = new Set<string>();
  for (const item of res.Items ?? []) {
    if (item.holdUntil > nowIso && item.jobId !== jobId) set.add(item.eventId);
  }
  return set;
}

/** Is this event held by someone other than `jobId` right now? */
export async function isHeldByOther(
  eventId: string,
  jobId: string,
): Promise<boolean> {
  return (await heldByOthers(jobId)).has(eventId);
}
