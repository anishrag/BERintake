// The channel-agnostic job-creation core. The Telegram bot, the partner web
// form, and any future web-admin page all funnel through `createJob`.

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { JOBS_TABLE, ddb } from "./db";
import { newJobId, newToken } from "./ids";
import { fetchSatelliteImage } from "./satellite";
import { jobPrefix, putObject } from "./s3";
import type {
  BerResult,
  BerSeed,
  ClientDetails,
  Job,
  JobSource,
  JobStatus,
} from "./types";

export interface CreateJobInput {
  client: ClientDetails;
  source: JobSource;
  partnerName?: string;
  note?: string;
  /** Partner submissions require owner approval before the client is contacted. */
  requireReview: boolean;
}

export async function createJob(input: CreateJobInput): Promise<Job> {
  const now = new Date().toISOString();
  const job: Job = {
    jobId: newJobId(),
    token: newToken(),
    status: input.requireReview ? "pending_review" : "quote_sent",
    source: input.source,
    partnerName: input.partnerName,
    note: input.note,
    client: input.client,
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: JOBS_TABLE, Item: job }));
  return job;
}

/**
 * Geocode the job's eircode, fetch its satellite image (framed to the point
 * +50m), upload the image to S3, and write `berSeed` onto the job. Called once
 * the client commits (books), so we only spend a geocode + static-map call on
 * real bookings. Best-effort: if imagery is unavailable it still records what it
 * can (address/coords), and if everything fails it simply writes nothing.
 */
export async function seedBerFromEircode(
  job: Job,
  details?: Record<string, unknown>,
): Promise<void> {
  const eircode = job.client?.eircode?.trim();
  if (!eircode) return;

  const fromDetails = seedFromDetails(details);

  // Best-effort imagery — if it fails we still persist the details/coords we have.
  const img = await fetchSatelliteImage(eircode);
  let satelliteImageKey: string | undefined;
  if (img) {
    try {
      satelliteImageKey = `${jobPrefix(job.jobId)}satellite.jpg`;
      await putObject(satelliteImageKey, img.buffer, img.contentType);
    } catch (err) {
      console.error(`satellite upload failed for ${job.jobId}`, err);
      satelliteImageKey = undefined;
    }
  }

  const seed: BerSeed = {
    ...fromDetails,
    // Prefer the client-entered address, then the geocoded one, then eircode.
    address: fromDetails.address ?? img?.formattedAddress ?? eircode,
    eircode,
    lat: img?.lat,
    lng: img?.lng,
    satelliteImageKey,
  };
  await setBerSeed(job.jobId, seed);
}

const asNum = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};
const asStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const asBool = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;

/** Map the free-form booking `details` (keyDetails) onto the typed BerSeed slice. */
export function seedFromDetails(
  details?: Record<string, unknown>,
): Partial<BerSeed> {
  if (!details) return {};
  const d = details;

  const extensions = (Array.isArray(d.extensions) ? d.extensions : [])
    .map((e) => {
      const ext = (e ?? {}) as Record<string, unknown>;
      return { year: asNum(ext.year), description: asStr(ext.description) };
    })
    .filter((e) => e.year !== undefined || e.description !== undefined);

  const insulation = {
    walls: asBool(d.insulationWalls),
    roof: asBool(d.insulationRoof),
    floor: asBool(d.insulationFloor),
    notes: asStr(d.insulationNotes),
  };
  const hasInsulation = Object.values(insulation).some((v) => v !== undefined);

  return {
    address: asStr(d.address),
    constructionYear: asNum(d.yearBuilt),
    propertyType: asStr(d.propertyType),
    heatingSystem: asStr(d.heatingSystem),
    windowYear: asNum(d.windowYear),
    doorYear: asNum(d.doorYear),
    extensions: extensions.length ? extensions : undefined,
    insulation: hasInsulation ? insulation : undefined,
    mprn: asStr(d.mprn),
    reason: asStr(d.reason),
  };
}

export async function setBerSeed(jobId: string, seed: BerSeed): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET berSeed = :s, updatedAt = :u",
      ExpressionAttributeValues: { ":s": seed, ":u": new Date().toISOString() },
    }),
  );
}

/** Attach the finished-assessment pointer and move the job to `assessed`. */
export async function setBerResult(
  jobId: string,
  ber: BerResult,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET ber = :b, #s = :st, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":b": ber,
        ":st": "assessed",
        ":u": new Date().toISOString(),
      },
    }),
  );
}

/** All jobs in a given status (via status-index), newest-relevant first. */
export async function findByStatus(status: JobStatus): Promise<Job[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: JOBS_TABLE,
      IndexName: "status-index",
      KeyConditionExpression: "#s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status },
    }),
  );
  return (res.Items ?? []) as Job[];
}

export async function getJobById(jobId: string): Promise<Job | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } }),
  );
  return res.Item as Job | undefined;
}

export async function getJobByToken(token: string): Promise<Job | undefined> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: JOBS_TABLE,
      IndexName: "token-index",
      KeyConditionExpression: "#t = :t",
      ExpressionAttributeNames: { "#t": "token" },
      ExpressionAttributeValues: { ":t": token },
      Limit: 1,
    }),
  );
  return res.Items?.[0] as Job | undefined;
}

export async function setJobStatus(
  jobId: string,
  status: JobStatus,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET #s = :s, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": status,
        ":u": new Date().toISOString(),
      },
    }),
  );
}

export async function setQuote(
  jobId: string,
  quote: Record<string, unknown>,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET quote = :q, #s = :s, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":q": quote,
        ":s": "quoted",
        ":u": new Date().toISOString(),
      },
    }),
  );
}

export async function setQuotePricing(
  jobId: string,
  serviceArea: string,
  quotePrices: Record<string, number>,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression:
        "SET serviceArea = :a, quotePrices = :p, updatedAt = :u",
      ExpressionAttributeValues: {
        ":a": serviceArea,
        ":p": quotePrices,
        ":u": new Date().toISOString(),
      },
    }),
  );
}

export async function setHold(
  jobId: string,
  eventId: string,
  holdUntil: string,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET #h = :h, updatedAt = :u",
      ExpressionAttributeNames: { "#h": "hold" },
      ExpressionAttributeValues: {
        ":h": { eventId, holdUntil },
        ":u": new Date().toISOString(),
      },
    }),
  );
}

export async function clearHold(jobId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "REMOVE #h",
      ExpressionAttributeNames: { "#h": "hold" },
    }),
  );
}

export async function setDetails(
  jobId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET keyDetails = :d, updatedAt = :u",
      ExpressionAttributeValues: {
        ":d": details,
        ":u": new Date().toISOString(),
      },
    }),
  );
}

export async function setInvoice(
  jobId: string,
  invoice: { id: string; total?: number; docNumber?: string; createdAt: string },
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET invoice = :i, updatedAt = :u",
      ExpressionAttributeValues: {
        ":i": invoice,
        ":u": new Date().toISOString(),
      },
    }),
  );
}

export async function setLoe(
  jobId: string,
  loe: { documentId: string; signingUrl?: string; status: string; createdAt: string },
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET loe = :l, updatedAt = :u",
      ExpressionAttributeValues: { ":l": loe, ":u": new Date().toISOString() },
    }),
  );
}

export async function setLoeStatus(jobId: string, status: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET loe.#s = :s, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status, ":u": new Date().toISOString() },
    }),
  );
}

/** Find the job whose LOE document matches `documentId` (used by the webhook). */
export async function findJobByLoeDocId(documentId: string): Promise<Job | undefined> {
  const res = await ddb.send(
    new ScanCommand({
      TableName: JOBS_TABLE,
      FilterExpression: "loe.documentId = :d",
      ExpressionAttributeValues: { ":d": documentId },
    }),
  );
  return res.Items?.[0] as Job | undefined;
}

export async function setBooking(
  jobId: string,
  booking: Record<string, unknown>,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET booking = :b, #s = :s, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":b": booking,
        ":s": "booked",
        ":u": new Date().toISOString(),
      },
    }),
  );
}

/** Record that a deferred funnel email was sent for this job ("quote" | "loe_nudge" | "save_for_later"). */
export async function addSentEmail(jobId: string, key: string): Promise<void> {
  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression:
        "SET sentEmails = list_append(if_not_exists(sentEmails, :empty), :k), updatedAt = :u",
      ExpressionAttributeValues: { ":empty": [], ":k": [key], ":u": now },
    }),
  );
}

export function clientLink(token: string): string {
  const base = process.env.PUBLIC_SITE_URL ?? "https://cannygreen.com";
  return `${base}/quote/${token}`;
}
