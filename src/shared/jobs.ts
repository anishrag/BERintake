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
import { POST_WORKS_DISCOUNT, computeQuotePricing, type HouseType } from "./pricing";
import { solarDiscount, solarPriceFor } from "./solarPartner";
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
  billTo?: "solar_partner" | "auctioneera";
  partnerName?: string;
  note?: string;
  postWorks?: boolean;
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
    billTo: input.billTo,
    partnerName: input.partnerName,
    note: input.note,
    postWorks: input.postWorks,
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

/** Attach the finished-assessment pointer and move the job to `surveyed`. */
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
        ":st": "surveyed",
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

// "YYYY-MM-DD" for a date in Irish local time (Europe/Dublin).
function dublinDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** The client has signed the LoE — the booking form is now read-only. */
export function isFormLocked(job: Job): boolean {
  return job.loe?.status === "completed";
}

/**
 * True once the client is fully done (LoE signed + invoice sent) AND the survey
 * day has passed — the whole magic link then stops working. "Survey day passed"
 * = the current Irish date is past the appointment's Irish date, so the link
 * lives through the whole survey day and dies at the following midnight.
 */
export function isLinkExpired(job: Job): boolean {
  if (job.loe?.status !== "completed") return false;
  if (!job.invoice?.id) return false;
  const start = (job.booking as { start?: string } | undefined)?.start;
  if (!start) return false;
  return dublinDate(new Date()) > dublinDate(new Date(start));
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
  const job = res.Items?.[0] as Job | undefined;
  // An expired link reads as "not found" everywhere (kills the PII read too).
  if (job && isLinkExpired(job)) return undefined;
  return job;
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
  opts?: { backfillEircode?: boolean },
): Promise<void> {
  const sets = ["keyDetails = :d", "updatedAt = :u"];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ":d": details,
    ":u": new Date().toISOString(),
  };

  // Backfill the client record's name/phone from the form when the client
  // supplied them. This is how a booking created without a name (e.g. a Telegram
  // pre-agreed booking) picks up the real name before the LoE/invoice are made.
  const name = typeof details.name === "string" ? details.name.trim() : "";
  if (name) {
    sets.push("client.#nm = :cn");
    names["#nm"] = "name";
    values[":cn"] = name;
  }
  const phone = typeof details.phone === "string" ? details.phone.trim() : "";
  if (phone) {
    sets.push("client.phone = :cp");
    values[":cp"] = phone;
  }
  // Eircode backfill is opt-in: callers set it only when the job was created
  // WITHOUT one (Auctioneera), so a client can't shift an existing job's
  // pricing/geocode basis by editing the form field.
  const eircode =
    typeof details.eircode === "string" ? details.eircode.trim() : "";
  if (opts?.backfillEircode && eircode) {
    sets.push("client.eircode = :ce");
    values[":ce"] = eircode;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET " + sets.join(", "),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
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
  status: JobStatus = "booked",
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET booking = :b, #s = :s, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":b": booking,
        ":s": status,
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

/** Persist the owner-confirmation gate (see shared/confirmation.ts). */
export async function setConfirmGate(
  jobId: string,
  gate: NonNullable<Job["confirmGate"]>,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET confirmGate = :g, updatedAt = :u",
      ExpressionAttributeValues: { ":g": gate, ":u": new Date().toISOString() },
    }),
  );
}

/** Set a trusted, agreed price (owner via Telegram / contractor table). */
export async function setAgreedPrice(jobId: string, price: number): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET agreedPrice = :p, updatedAt = :u",
      ExpressionAttributeValues: { ":p": price, ":u": new Date().toISOString() },
    }),
  );
}

/**
 * The authoritative price for a job, for the invoice and the LoE fee. Never
 * trusts a client-supplied price:
 *   1. an explicitly agreed price (owner/contractor) wins;
 *   2. solar-partner jobs: the partner's agreed table (solar.env) for the
 *      property type the client selected — never the public zone prices, and
 *      no post-works discount. Undefined until the table is configured;
 *   3. otherwise the server-computed zone price for the eircode + property type
 *      (recomputed and cached if not already stored);
 *   4. otherwise undefined (caller treats as "no price").
 */
export async function resolveJobPrice(job: Job): Promise<number | undefined> {
  if (typeof job.agreedPrice === "number") return job.agreedPrice;

  const propertyType = (job.quote as { propertyType?: string } | undefined)
    ?.propertyType;
  if (!propertyType) return undefined;

  if (job.billTo === "solar_partner") {
    // Same zone resolution as the public prices (cached on the job by the
    // first form load), but read off the partner's table.
    let area = job.serviceArea;
    if (!area) {
      const eircode = job.client?.eircode;
      if (!eircode) return undefined;
      const computed = await computeQuotePricing(eircode);
      if (!computed) return undefined;
      await setQuotePricing(job.jobId, computed.serviceArea, computed.prices);
      area = computed.serviceArea;
    }
    return solarPriceFor(area, propertyType);
  }

  let base = job.quotePrices?.[propertyType];
  if (typeof base !== "number") {
    const eircode = job.client?.eircode;
    if (!eircode) return undefined;
    const computed = await computeQuotePricing(eircode);
    if (!computed) return undefined;
    await setQuotePricing(job.jobId, computed.serviceArea, computed.prices);
    base = computed.prices[propertyType as HouseType];
  }
  if (typeof base !== "number") return undefined;
  // Post-works BER: a fixed discount off the zone price (server-side, so the
  // amount can't be tampered — the client only claims eligibility, we verify).
  return job.postWorks ? Math.max(0, base - POST_WORKS_DISCOUNT) : base;
}

// The partner-discount counter lives as a special item in the jobs table
// (the same trick botState uses for its upd# rows) — atomic, no extra table.
// `used` counts ALL discounts given, including the pre-counter ones seeded
// from SOLAR_DISCOUNT_ALREADY_USED, so its value is directly the "n" in n/15.
const SOLAR_DISCOUNT_COUNTER_KEY = "solar#discountCounter";

/**
 * Atomically claim one partner discount. Returns its sequence number (n of
 * total) and amount, or undefined when no deal is configured or the quota is
 * spent. Call releaseSolarDiscount() if invoice creation then fails.
 */
export async function claimSolarDiscount(): Promise<
  { seq: number; amount: number; total: number } | undefined
> {
  const deal = solarDiscount();
  if (!deal) return undefined;
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: JOBS_TABLE,
        Key: { jobId: SOLAR_DISCOUNT_COUNTER_KEY },
        UpdateExpression: "SET #u = if_not_exists(#u, :seed) + :one",
        ConditionExpression: "attribute_not_exists(#u) OR #u < :max",
        ExpressionAttributeNames: { "#u": "used" },
        ExpressionAttributeValues: {
          ":seed": deal.alreadyUsed,
          ":one": 1,
          ":max": deal.total,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const seq = Number(res.Attributes?.used);
    if (!Number.isFinite(seq)) return undefined;
    return { seq, amount: deal.amount, total: deal.total };
  } catch (e: any) {
    // Quota spent — every remaining invoice is full price.
    if (e?.name === "ConditionalCheckFailedException") return undefined;
    throw e;
  }
}

/** Hand back a claimed discount (the invoice failed after claiming). */
export async function releaseSolarDiscount(): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: JOBS_TABLE,
        Key: { jobId: SOLAR_DISCOUNT_COUNTER_KEY },
        UpdateExpression: "SET #u = #u - :one",
        ConditionExpression: "#u > :zero",
        ExpressionAttributeNames: { "#u": "used" },
        ExpressionAttributeValues: { ":one": 1, ":zero": 0 },
      }),
    );
  } catch (err) {
    console.error("could not release solar discount claim", err);
  }
}

export function clientLink(token: string): string {
  const base = process.env.PUBLIC_SITE_URL ?? "https://cannygreen.com";
  return `${base}/quote/${token}`;
}
