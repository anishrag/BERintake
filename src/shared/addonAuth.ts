// Shared-secret auth for the /jobs/lookup + /jobs/{id}/checklist endpoints the
// Gmail add-on calls. The add-on sends `x-addon-key` (stored in its Apps Script
// PropertiesService); we compare it to the ADDON_ACCESS_KEY secret (hydrated
// from SSM). Separate from the surveyor key so the tablet and the add-on don't
// share a credential.

import type { APIGatewayProxyEventV2 } from "aws-lambda";

/** True if the request carries a valid add-on key. */
export function isAddon(event: APIGatewayProxyEventV2): boolean {
  const expected = process.env.ADDON_ACCESS_KEY;
  if (!expected) return false; // fail closed if unconfigured
  const got = event.headers?.["x-addon-key"];
  return typeof got === "string" && got === expected;
}
