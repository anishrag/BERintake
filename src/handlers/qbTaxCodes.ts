// GET /qb/taxcodes — lists the connected QuickBooks company's tax codes
// (Id, name, and the sales rate each maps to) so you can find the value for
// QB_TAX_CODE_ID / QbTaxCodeId. Read-only helper; needs QuickBooks connected.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { escapeHtml } from "../shared/html";
import { qbFetch } from "../shared/quickbooks";
import { hydrateSecrets } from "../shared/secrets";

const MV = "minorversion=65";

async function query(sql: string): Promise<any> {
  const res = await qbFetch(`/query?query=${encodeURIComponent(sql)}&${MV}`);
  if (!res.ok) throw new Error(`qb query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#222">${body}</div>`;

export const handler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  await hydrateSecrets();

  let taxCodes: any[];
  const rateById: Record<string, any> = {};
  try {
    const tc = await query("SELECT * FROM TaxCode");
    taxCodes = tc.QueryResponse?.TaxCode ?? [];
    const tr = await query("SELECT * FROM TaxRate");
    for (const r of tr.QueryResponse?.TaxRate ?? []) rateById[r.Id] = r;
  } catch (err) {
    console.error("qb taxcodes failed", err);
    return {
      statusCode: 502,
      headers: { "content-type": "text/html" },
      body: page(
        `<h2>Couldn't fetch tax codes</h2><p>Is QuickBooks connected? Check <code>/qb/status</code> first.</p><pre style="white-space:pre-wrap;color:#a00">${escapeHtml(String(err))}</pre>`,
      ),
    };
  }

  const salesRates = (c: any): string => {
    const details = c.SalesTaxRateList?.TaxRateDetail ?? [];
    const parts = details.map((d: any) => {
      const r = rateById[d.TaxRateRef?.value];
      if (!r) return escapeHtml(d.TaxRateRef?.value ?? "?");
      const pct = r.RateValue != null ? `${r.RateValue}%` : "?";
      return `${escapeHtml(r.Name)} (${pct})`;
    });
    return parts.length ? parts.join(", ") : "—";
  };

  const rows = taxCodes
    .map(
      (c) =>
        `<tr><td><code>${escapeHtml(c.Id)}</code></td><td>${escapeHtml(c.Name ?? "")}</td><td>${salesRates(c)}</td><td style="text-align:center">${c.Active ? "✓" : "—"}</td></tr>`,
    )
    .join("");

  const body = `
    <h2>QuickBooks tax codes</h2>
    <p>Copy the <b>Id</b> of the VAT code you charge into <code>QbTaxCodeId</code> (env <code>QB_TAX_CODE_ID</code>), then redeploy. These are the codes for the <b>currently connected company</b>.</p>
    <table style="border-collapse:collapse;width:100%" border="1" cellpadding="8">
      <thead><tr style="background:#f3f4f6;text-align:left"><th>Id</th><th>Name</th><th>Sales rate(s)</th><th>Active</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4">No tax codes found.</td></tr>`}</tbody>
    </table>
    <p style="color:#666;font-size:13px;margin-top:16px">Tip: pick the code whose sales rate matches the VAT you charge (e.g. the standard Irish rate). If unsure which applies to BER assessments, confirm with your accountant.</p>`;

  return {
    statusCode: 200,
    headers: { "content-type": "text/html" },
    body: page(body),
  };
};
