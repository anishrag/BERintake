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
import type { ClientDetails, Job, JobSource, JobStatus } from "./types";

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

/** All booked-but-not-confirmed jobs (for the reminder sweep). */
export async function findBooked(): Promise<Job[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: JOBS_TABLE,
      IndexName: "status-index",
      KeyConditionExpression: "#s = :b",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":b": "booked" },
    }),
  );
  return (res.Items ?? []) as Job[];
}

export async function addReminderSent(jobId: string, key: string): Promise<void> {
  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression:
        "SET remindersSent = list_append(if_not_exists(remindersSent, :empty), :k), updatedAt = :u",
      ExpressionAttributeValues: { ":empty": [], ":k": [key], ":u": now },
    }),
  );
}

export function clientLink(token: string): string {
  const base = process.env.PUBLIC_SITE_URL ?? "https://cannygreen.com";
  return `${base}/quote/${token}`;
}
