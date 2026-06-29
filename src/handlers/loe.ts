// POST /jobs/{token}/loe — create (or return) the SignWell Letter of
// Engagement for this job and hand back an embedded signing URL.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobByToken, setLoe } from "../shared/jobs";
import { createLoeDocument } from "../shared/signwell";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const token = event.pathParameters?.token;
  if (!token) return json(400, { error: "missing token" });

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") return json(404, { error: "not found" });

  // Reuse the existing document if one is in progress.
  if (job.loe?.documentId && job.loe.status !== "completed") {
    return json(200, { signingUrl: job.loe.signingUrl, status: job.loe.status });
  }
  if (job.loe?.status === "completed") {
    return json(200, { status: "completed" });
  }

  try {
    const doc = await createLoeDocument(job);
    const loe = {
      documentId: doc.documentId,
      signingUrl: doc.signingUrl,
      status: "sent",
      createdAt: new Date().toISOString(),
    };
    await setLoe(job.jobId, loe);
    return json(200, { signingUrl: doc.signingUrl, status: "sent" });
  } catch (err) {
    console.error("loe creation failed", err);
    return json(502, { error: "loe-failed" });
  }
};
