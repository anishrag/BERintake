// Thin wrapper over the S3 artifacts bucket that holds per-job BER assets:
//   bers/{jobId}/satellite.jpg   — written at intake (server-side)
//   bers/{jobId}/data.json       — pushed by the tablet on completion
//   bers/{jobId}/photos/*.jpg    — pushed by the tablet on completion
// The tablet never gets bucket credentials; it uploads via presigned PUT URLs.

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});

export const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;

/** Prefix under which all of a job's BER assets live. */
export const jobPrefix = (jobId: string): string => `bers/${jobId}/`;

/** Server-side upload (used for the satellite image at intake). */
export async function putObject(
  key: string,
  body: Uint8Array | Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Short-lived URL the tablet can PUT an object to (default 15 min). */
export function presignPut(
  key: string,
  contentType: string,
  expiresIn = 900,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn },
  );
}

/** Short-lived URL to GET an object (e.g. the satellite image for the tablet). */
export function presignGet(key: string, expiresIn = 900): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: key }),
    { expiresIn },
  );
}
