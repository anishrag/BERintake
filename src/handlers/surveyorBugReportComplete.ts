// POST /surveyor/bug-reports/{bugReportId}/complete — the tablet reports that
// the audio + state blobs have been uploaded to S3 via the presigned URLs. We
// stamp `uploadedAt` on the row.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { setBugReportUploaded } from "../shared/bugReports";
import { isSurveyor } from "../shared/surveyorAuth";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if (!isSurveyor(event)) return json(401, { error: "unauthorized" });

  const bugReportId = event.pathParameters?.bugReportId;
  if (!bugReportId) return json(400, { error: "missing bugReportId" });

  await setBugReportUploaded(bugReportId);

  return json(200, { ok: true });
};
