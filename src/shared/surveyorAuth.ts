// Shared-secret auth for the /surveyor/* endpoints the tablet (BER_APP) calls.
// The tablet sends `x-surveyor-key`; we compare it to the SURVEYOR_ACCESS_KEY
// param. Same simple shared-secret model as the partner form access key.

import type { APIGatewayProxyEventV2 } from "aws-lambda";

/** True if the request carries a valid surveyor key. */
export function isSurveyor(event: APIGatewayProxyEventV2): boolean {
  const expected = process.env.SURVEYOR_ACCESS_KEY;
  if (!expected) return false; // fail closed if unconfigured
  const got = event.headers?.["x-surveyor-key"];
  return typeof got === "string" && got === expected;
}
