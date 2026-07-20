// GET /jobs/lookup?email=&hints= — resolve an opened client email to the open
// BER job(s) awaiting details, so the Gmail add-on can show the checklist.
//
// Matching priority (highest confidence first):
//   1. email  — exact match against a job's client email (the add-on passes the
//      message Reply-To, which is the client's address; the visible From is the
//      forwards@ forwarder).
//   2. hints  — subject+body text: client name / property address tokens, used
//      to disambiguate multiple email matches or as a fallback when the email
//      doesn't match. Never authoritative on its own.
//
// Only jobs in the details_* phase are considered.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { findByStatus } from "../shared/jobs";
import { hydrateSecrets } from "../shared/secrets";
import { isAddon } from "../shared/addonAuth";
import type { DetailsChecklist, Job } from "../shared/types";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Lowercase, collapse to alnum-separated words. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function propertyAddress(job: Job): string {
  const kd = (job.keyDetails ?? {}) as { address?: string };
  return kd.address || job.berSeed?.address || job.client?.eircode || "";
}

/** The API's checklist shape (spec snake_case), with an outstanding count. */
function checklistOut(checklist: DetailsChecklist | undefined) {
  const items = checklist?.items ?? [];
  return {
    outstanding_count: items.filter((i) => !i.done).length,
    items: items.map((i) => ({
      item_id: i.itemId,
      label: i.label,
      done: i.done,
    })),
  };
}

/**
 * A weak text-overlap score of a job against the email hints: +2 if the whole
 * client name appears, +1 per name word, +2 if the address number + a street
 * word appear. Used only to rank/fallback, never as sole authority.
 */
function hintScore(job: Job, hints: string): number {
  const h = norm(hints);
  if (!h) return 0;
  let score = 0;
  const name = norm(job.client?.name ?? "");
  if (name) {
    if (h.includes(name)) score += 2;
    for (const w of name.split(" ")) {
      if (w.length >= 3 && new RegExp(`\\b${w}\\b`).test(h)) score += 1;
    }
  }
  const addr = norm(propertyAddress(job));
  if (addr) {
    const num = addr.match(/\b\d+\b/)?.[0];
    const streetWords = addr
      .split(" ")
      .filter((w) => w.length >= 4 && !/^\d+$/.test(w));
    const numHit = num ? new RegExp(`\\b${num}\\b`).test(h) : false;
    const streetHit = streetWords.some((w) => new RegExp(`\\b${w}\\b`).test(h));
    if (numHit && streetHit) score += 2;
    else if (streetHit) score += 1;
  }
  return score;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();
  if (!isAddon(event)) return json(401, { error: "unauthorized" });

  const q = event.queryStringParameters ?? {};
  const email = (q.email ?? "").trim().toLowerCase();
  const hints = (q.hints ?? "").trim();
  if (!email && !hints)
    return json(400, { error: "email or hints required" });

  // Candidate pool: open jobs in the details phase (requested → still allow a
  // provided one to be reopened/corrected).
  const pool: Job[] = [
    ...(await findByStatus("details_requested")),
    ...(await findByStatus("details_provided")),
  ];

  let hits: { job: Job; reason: string }[] = [];
  if (email) {
    const emailHits = pool.filter(
      (j) => (j.client?.email ?? "").trim().toLowerCase() === email,
    );
    if (emailHits.length === 1) {
      hits = [{ job: emailHits[0], reason: "client_email" }];
    } else if (emailHits.length > 1) {
      // Disambiguate several jobs for one client by the hint text.
      hits = emailHits
        .map((job) => ({ job, reason: "client_email", score: hintScore(job, hints) }))
        .sort((a, b) => b.score - a.score)
        .map(({ job, reason }) => ({ job, reason }));
    }
  }
  // Fallback: no email match → text hints only (address/name).
  if (hits.length === 0 && hints) {
    hits = pool
      .map((job) => ({ job, score: hintScore(job, hints) }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .map(({ job }) => ({ job, reason: "address" }));
  }

  const matches = hits.map(({ job, reason }) => ({
    job_id: job.jobId,
    client_name: job.client?.name ?? "",
    property_address: propertyAddress(job),
    match_reason: reason,
    checklist: checklistOut(job.detailsChecklist),
  }));

  return json(200, { matches });
};
