// POST /jobs/{jobId}/checklist/presign — mint short-lived presigned PUT URLs so
// the Gmail add-on can upload client-supplied files straight to S3, one per
// checklist item. Files land under the job prefix, keyed by item:
//   bers/{jobId}/details/{itemId}/{filename}
//
// Body: { files: [{ item_id, filename, contentType }] }
// Response: { uploads: [{ item_id, filename, key, url, contentType }] }
//
// The add-on then PUTs each blob to its url (echoing contentType), and calls
// POST /jobs/{jobId}/checklist with the returned key to record it + mark done.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getJobById } from "../shared/jobs";
import { jobPrefix, presignPut } from "../shared/s3";
import { hydrateSecrets } from "../shared/secrets";
import { isAddon } from "../shared/addonAuth";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Safe S3 key segment: keep word chars, space, dot, dash; collapse the rest. */
function safe(s: string, fallback: string): string {
  const out = (s || "")
    .replace(/[^a-zA-Z0-9 ._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out || fallback;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  if (!isAddon(event)) return json(401, { error: "unauthorized" });

  const jobId = event.pathParameters?.jobId;
  if (!jobId) return json(400, { error: "missing jobId" });

  const job = await getJobById(jobId);
  if (!job || job.status === "discarded")
    return json(404, { error: "not found" });

  let parsed: {
    files?: { item_id?: unknown; filename?: unknown; contentType?: unknown }[];
  };
  try {
    parsed = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const files = Array.isArray(parsed.files)
    ? parsed.files.filter(
        (f): f is { item_id: string; filename: string; contentType?: string } =>
          !!f && typeof f.item_id === "string" && typeof f.filename === "string",
      )
    : [];
  if (files.length === 0) return json(400, { error: "no files" });

  const prefix = jobPrefix(jobId);
  const uploads = await Promise.all(
    files.map(async (f) => {
      const contentType =
        typeof f.contentType === "string" && f.contentType
          ? f.contentType
          : "application/octet-stream";
      const filename = safe(f.filename, "attachment");
      const key = `${prefix}details/${safe(f.item_id, "item")}/${filename}`;
      const url = await presignPut(key, contentType);
      return { item_id: f.item_id, filename, key, url, contentType };
    }),
  );

  return json(200, { uploads });
};
