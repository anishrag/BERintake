// The channel-agnostic job-creation core. The Telegram bot, the partner web
// form, and any future web-admin page all funnel through `createJob`.

import {
  GetCommand,
  PutCommand,
  QueryCommand,
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

export function clientLink(token: string): string {
  const base = process.env.PUBLIC_SITE_URL ?? "https://cannygreen.ie";
  return `${base}/quote/${token}`;
}
