// Build QuickBooks invoices for a job: ensure a Customer + a "BER Assessment"
// service item exist, then create the invoice and fetch its PDF.

import { setInvoice } from "./jobs";
import { qbFetch } from "./quickbooks";
import type { ClientDetails, Job } from "./types";

const MV = "minorversion=65";

async function qbQuery(sql: string): Promise<any> {
  const res = await qbFetch(`/query?query=${encodeURIComponent(sql)}&${MV}`);
  if (!res.ok) throw new Error(`qb query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function qbPost(entity: string, payload: unknown): Promise<any> {
  const res = await qbFetch(`/${entity}?${MV}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`qb ${entity} create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const esc = (s: string) => s.replace(/'/g, "\\'");

// VAT-registered companies (incl. the GB/IE sandbox) require a tax code on
// every line. Default to a zero/exempt code (total = quoted price); override
// with QB_TAX_CODE_ID once the real VAT treatment is decided.
let cachedTaxCode: string | null | undefined;
async function getTaxCodeId(): Promise<string | undefined> {
  const override = process.env.QB_TAX_CODE_ID;
  if (override) return override;
  if (cachedTaxCode !== undefined) return cachedTaxCode ?? undefined;

  try {
    const q = await qbQuery(`SELECT Id, Name FROM TaxCode`);
    const codes: any[] = q.QueryResponse?.TaxCode ?? [];
    if (!codes.length) {
      cachedTaxCode = null;
      return undefined;
    }
    const zero = codes.find((c) =>
      /no vat|exempt|zero|^z\b|0\.0/i.test(c.Name || ""),
    );
    cachedTaxCode = (zero ?? codes[0]).Id;
    return cachedTaxCode ?? undefined;
  } catch (err) {
    console.warn("could not list tax codes", err);
    cachedTaxCode = null;
    return undefined;
  }
}

async function ensureCustomer(client: ClientDetails): Promise<string> {
  const display = `${client.name} (${client.eircode})`;
  const q = await qbQuery(`SELECT Id FROM Customer WHERE DisplayName = '${esc(display)}'`);
  const existing = q.QueryResponse?.Customer?.[0];
  if (existing) return existing.Id;

  const created = await qbPost("customer", {
    DisplayName: display,
    PrimaryEmailAddr: client.email ? { Address: client.email } : undefined,
  });
  return created.Customer.Id;
}

async function ensureBerItem(): Promise<string> {
  const q = await qbQuery(`SELECT Id FROM Item WHERE Name = 'BER Assessment'`);
  const existing = q.QueryResponse?.Item?.[0];
  if (existing) return existing.Id;

  // A Service item needs an income account to post to.
  const acc = await qbQuery(`SELECT Id FROM Account WHERE AccountType = 'Income' MAXRESULTS 1`);
  const incomeId = acc.QueryResponse?.Account?.[0]?.Id;
  if (!incomeId) throw new Error("no income account in QuickBooks to attach the item to");

  const created = await qbPost("item", {
    Name: "BER Assessment",
    Type: "Service",
    IncomeAccountRef: { value: incomeId },
  });
  return created.Item.Id;
}

function jobPrice(job: Job): number | undefined {
  const q: any = job.quote || {};
  if (typeof q.price === "number") return q.price;
  if (job.quotePrices && typeof q.propertyType === "string") {
    return job.quotePrices[q.propertyType];
  }
  return undefined;
}

/** Create the invoice for a job if it doesn't have one yet; returns its metadata. */
export async function ensureInvoiceForJob(
  job: Job,
): Promise<{ id: string; total?: number; docNumber?: string }> {
  if (job.invoice?.id) return job.invoice;

  const price = jobPrice(job);
  if (!price) throw new Error("no-price");

  const customerId = await ensureCustomer(job.client);
  const itemId = await ensureBerItem();
  const taxCodeId = await getTaxCodeId();

  const lineDetail: any = { ItemRef: { value: itemId }, Qty: 1, UnitPrice: price };
  if (taxCodeId) lineDetail.TaxCodeRef = { value: taxCodeId };

  const invoicePayload: any = {
    Line: [
      {
        DetailType: "SalesItemLineDetail",
        Amount: price,
        Description: `BER Assessment — ${job.client.eircode}`,
        SalesItemLineDetail: lineDetail,
      },
    ],
    CustomerRef: { value: customerId },
    BillEmail: job.client.email ? { Address: job.client.email } : undefined,
  };
  if (taxCodeId) invoicePayload.GlobalTaxCalculation = "TaxExcluded";

  const created = await qbPost("invoice", invoicePayload);

  const inv = created.Invoice;
  const meta = {
    id: inv.Id as string,
    total: inv.TotalAmt as number,
    docNumber: inv.DocNumber as string,
    createdAt: new Date().toISOString(),
  };
  await setInvoice(job.jobId, meta);
  return meta;
}

export async function getInvoicePdf(invoiceId: string): Promise<Buffer> {
  const res = await qbFetch(`/invoice/${invoiceId}/pdf`, {
    headers: { Accept: "application/pdf" },
  });
  if (!res.ok) throw new Error(`qb pdf fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
