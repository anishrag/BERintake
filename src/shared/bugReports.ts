// Bug reports uploaded by the BER_APP tablet. Mirrors `jobs.ts`: the DynamoDB
// writer/reader core. The audio + JSON state dump live in S3 under
// `bug-reports/{id}/`; this row is the queryable record.

import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { BUG_REPORTS_TABLE, ddb } from "./db";
import type { BugReport } from "./types";

export async function createBugReport(item: BugReport): Promise<void> {
  await ddb.send(new PutCommand({ TableName: BUG_REPORTS_TABLE, Item: item }));
}

/** Record that the tablet has finished uploading the blobs. */
export async function setBugReportUploaded(bugReportId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: BUG_REPORTS_TABLE,
      Key: { bugReportId },
      UpdateExpression: "SET uploadedAt = :u",
      ExpressionAttributeValues: { ":u": new Date().toISOString() },
    }),
  );
}

/** Mark a report fixed (from home). */
export async function setBugReportFixed(bugReportId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: BUG_REPORTS_TABLE,
      Key: { bugReportId },
      UpdateExpression: "SET #s = :s, fixedAt = :f",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "fixed",
        ":f": new Date().toISOString(),
      },
    }),
  );
}

/** All still-open reports (via status-index), for the at-home triage tool. */
export async function listOpenBugReports(): Promise<BugReport[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: BUG_REPORTS_TABLE,
      IndexName: "status-index",
      KeyConditionExpression: "#s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "open" },
    }),
  );
  return (res.Items ?? []) as BugReport[];
}
