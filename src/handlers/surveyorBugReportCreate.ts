// POST /surveyor/bug-reports — the tablet opens a bug report. We create the
// DynamoDB row and mint short-lived presigned PUT URLs the tablet uses to
// upload the JSON state dump (always) and the audio recording (if any). The
// tablet reports completion via /surveyor/bug-reports/{id}/complete.
//
// Body: { note?, berId?, address?, appContext?, hasAudio: boolean }
// Returns: { bugReportId, statePutUrl, audioPutUrl? }

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { createBugReport } from "../shared/bugReports";
import { newJobId } from "../shared/ids";
import { presignPut } from "../shared/s3";
import { isSurveyor } from "../shared/surveyorAuth";
import type { BugReport } from "../shared/types";
import { hydrateSecrets } from "../shared/secrets";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  if (!isSurveyor(event)) return json(401, { error: "unauthorized" });

  let body: {
    note?: string;
    berId?: string;
    address?: string;
    appContext?: Record<string, string>;
    hasAudio?: boolean;
  };
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const bugReportId = newJobId();
  const hasAudio = body.hasAudio === true;
  const prefix = `bug-reports/${bugReportId}/`;
  const stateKey = `${prefix}state.json`;
  const audioKey = hasAudio ? `${prefix}audio.m4a` : undefined;

  const item: BugReport = {
    bugReportId,
    createdAt: new Date().toISOString(),
    status: "open",
    note: body.note,
    berId: body.berId,
    address: body.address,
    appContext: body.appContext,
    audioKey,
    stateKey,
    hasAudio,
  };
  await createBugReport(item);

  const statePutUrl = await presignPut(stateKey, "application/json");
  const audioPutUrl = audioKey
    ? await presignPut(audioKey, "audio/mp4")
    : undefined;

  return json(200, { bugReportId, statePutUrl, audioPutUrl });
};
