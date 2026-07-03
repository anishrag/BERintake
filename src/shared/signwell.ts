// SignWell e-signature: create the Letter of Engagement from a template,
// prefilled with the job's data, and return an embedded signing URL.
// Template field API IDs must match those set in the SignWell template.

import { resolveJobPrice } from "./jobs";
import type { Job } from "./types";

const API_URL = "https://www.signwell.com/api/v1/document_templates/documents";
const DOCS_URL = "https://www.signwell.com/api/v1/documents";

function apiKey(): string {
  const k = process.env.SIGNWELL_API_KEY;
  if (!k) throw new Error("SIGNWELL_API_KEY not set");
  return k;
}

function fmtDate(): string {
  // SignWell date fields require full ISO 8601 (with time), e.g. 2026-06-29T00:00:00Z.
  return new Date().toISOString();
}

function extensionsSummary(kd: any): string {
  const ext = Array.isArray(kd?.extensions) ? kd.extensions : [];
  if (!ext.length) return "None";
  // "<date> (<comment>), <date> (<comment>), …"
  return ext
    .map((e: any) => (e.description ? `${e.year} (${e.description})` : `${e.year}`))
    .join(", ");
}

export interface LoeResult {
  documentId: string;
  signingUrl?: string;
}

export async function createLoeDocument(job: Job): Promise<LoeResult> {
  const templateId = process.env.SIGNWELL_TEMPLATE_ID;
  if (!templateId) throw new Error("SIGNWELL_TEMPLATE_ID not set");
  const placeholder = process.env.SIGNWELL_PLACEHOLDER || "Client";
  const testMode = process.env.SIGNWELL_TEST_MODE !== "false";

  const kd: any = job.keyDetails || {};
  // Authoritative price (agreed price, else server zone price) — never the
  // client-supplied one.
  const price = await resolveJobPrice(job);

  const templateFields = [
    { api_id: "client_name", value: job.client.name },
    // SignWell requires unique field API IDs — use client_name_2 (_3, …) for
    // repeats of the same value in the letter.
    { api_id: "client_name_2", value: job.client.name },
    { api_id: "client_firstname", value: job.client.name.split(" ")[0] },
    { api_id: "client_address", value: kd.address || "" },
    { api_id: "client_eircode", value: job.client.eircode },
    { api_id: "letter_date", value: fmtDate() },
    { api_id: "ber_fee", value: price != null ? String(price) : "" },
    { api_id: "year_built", value: kd.yearBuilt ? String(kd.yearBuilt) : "" },
    { api_id: "year_extension", value: extensionsSummary(kd) },
  ];

  const body = {
    template_id: templateId,
    test_mode: testMode,
    embedded_signing: true,
    recipients: [
      {
        id: "client",
        placeholder_name: placeholder,
        name: job.client.name,
        email: job.client.email,
      },
    ],
    template_fields: templateFields,
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "X-Api-Key": apiKey(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`signwell create failed: ${res.status} ${await res.text()}`);
  }
  const data: any = await res.json();
  const recipient = (data.recipients || [])[0] || {};
  return {
    documentId: data.id,
    signingUrl: recipient.embedded_signing_url || recipient.signing_url,
  };
}

// Download the completed (signed) document PDF. Handles both response shapes:
// the PDF streamed directly, or JSON pointing at a file URL.
export async function getSignedLoePdf(documentId: string): Promise<Buffer> {
  const res = await fetch(
    `${DOCS_URL}/${encodeURIComponent(documentId)}/completed_pdf`,
    { headers: { "X-Api-Key": apiKey() } },
  );
  if (!res.ok) {
    throw new Error(`signwell completed_pdf failed: ${res.status} ${await res.text()}`);
  }
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const data: any = await res.json();
    const url = data.file_url || data.url || data.pdf_url;
    if (!url) throw new Error("signwell completed_pdf: no file url in response");
    const file = await fetch(url);
    if (!file.ok) throw new Error(`signwell pdf download failed: ${file.status}`);
    return Buffer.from(await file.arrayBuffer());
  }
  return Buffer.from(await res.arrayBuffer());
}
