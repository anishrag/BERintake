// POST /jobs/{jobId}/checklist — the Gmail add-on ticks off checklist items as
// the client supplies them. Toggles are idempotent; when every item is done the
// job advances to `details_provided` (and back to `details_requested` if one is
// un-ticked). Returns the updated checklist so the card re-renders from
// authoritative state.
//
// Body: { updates: [{ item_id, done }], source?, actor? }

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { applyChecklistUpdates, getJobById } from "../shared/jobs";
import { hydrateSecrets } from "../shared/secrets";
import { isAddon } from "../shared/addonAuth";
import type { DetailsChecklist } from "../shared/types";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function checklistOut(checklist: DetailsChecklist) {
  return {
    outstanding_count: checklist.items.filter((i) => !i.done).length,
    items: checklist.items.map((i) => ({
      item_id: i.itemId,
      label: i.label,
      done: i.done,
    })),
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  if (!isAddon(event)) return json(401, { error: "unauthorized" });

  const jobId = event.pathParameters?.jobId;
  if (!jobId) return json(400, { error: "missing jobId" });

  let parsed: { updates?: { item_id?: unknown; done?: unknown }[] };
  try {
    parsed = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const updates = Array.isArray(parsed.updates)
    ? parsed.updates
        .filter(
          (u): u is { item_id: string; done: boolean } =>
            !!u && typeof u.item_id === "string" && typeof u.done === "boolean",
        )
        .map((u) => ({ itemId: u.item_id, done: u.done }))
    : [];
  if (updates.length === 0)
    return json(400, { error: "no valid updates" });

  const job = await getJobById(jobId);
  if (!job || job.status === "discarded")
    return json(404, { error: "not found" });

  const updated = await applyChecklistUpdates(job, updates);
  if (!updated)
    return json(409, { error: "job has no checklist" });

  const allDone =
    updated.items.length > 0 && updated.items.every((i) => i.done);
  return json(200, {
    jobId,
    status: allDone ? "details_provided" : "details_requested",
    checklist: checklistOut(updated),
  });
};
