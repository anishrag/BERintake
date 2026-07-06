// Build QuickBooks invoices for a job: ensure a Customer + a "BER Assessment"
// service item exist, then create the invoice and fetch its PDF.

import { resolveJobPrice, setInvoice } from "./jobs";
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

// Shown on the invoice PDF (CustomerMemo). How the client pays us.
const PAYMENT_MEMO = `Please make the payment to:
Recipient: CANNYGREEN LIMITED
Recipient address: 168 Charnwood, A98 FX46, Bray, Ireland
IBAN: IE92 REVO 9903 6040 7252 09
BIC: REVOIE23
or send to @cannyg5igz on Revolut`;

// The SEAI publishing fee is a fixed outlay on every BER, passed on to the
// client at 0% / No VAT. The quoted price is the all-in, VAT-INCLUSIVE total —
// it already includes both the VAT and this fee — so invoices are built
// TaxInclusive and split into two lines:
//   - "BER survey of <eircode>" at the standard rate  (QB_TAX_CODE_ID)
//   - "Outlay SEAI publishing fee" at 0% / No VAT      (QB_OUTLAY_TAX_CODE_ID)
const SEAI_PUBLISHING_FEE = 30;
const round2 = (n: number) => Math.round(n * 100) / 100;

// A QuickBooks TaxCode id: an env override (per line kind), else a best-effort
// zero/exempt code discovered from the company (cached per env var). Get the
// real ids from GET /qb/taxcodes.
const taxCodeCache: Record<string, string | null> = {};
async function taxCodeId(envVar: string): Promise<string | undefined> {
  const override = process.env[envVar];
  if (override) return override;
  if (taxCodeCache[envVar] !== undefined) return taxCodeCache[envVar] ?? undefined;
  try {
    const q = await qbQuery(`SELECT Id, Name FROM TaxCode`);
    const codes: any[] = q.QueryResponse?.TaxCode ?? [];
    const zero = codes.find((c) =>
      /no vat|exempt|zero|^z\b|0\.0/i.test(c.Name || ""),
    );
    taxCodeCache[envVar] = (zero ?? codes[0])?.Id ?? null;
    return taxCodeCache[envVar] ?? undefined;
  } catch (err) {
    console.warn("could not list tax codes", err);
    taxCodeCache[envVar] = null;
    return undefined;
  }
}
const surveyTaxCode = () => taxCodeId("QB_TAX_CODE_ID");
const outlayTaxCode = () => taxCodeId("QB_OUTLAY_TAX_CODE_ID");

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

// The survey date as YYYY-MM-DD (QuickBooks DueDate format), or undefined if
// the slot isn't booked yet.
function surveyDueDate(job: Job): string | undefined {
  const start = (job.booking as any)?.start;
  if (!start) return undefined;
  const d = new Date(start);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

/** Create the invoice for a job if it doesn't have one yet; returns its metadata. */
export async function ensureInvoiceForJob(
  job: Job,
): Promise<{ id: string; total?: number; docNumber?: string }> {
  if (job.invoice?.id) return job.invoice;

  const price = await resolveJobPrice(job);
  if (!price) throw new Error("no-price");

  const customerId = await ensureCustomer(job.client);
  const itemId = await ensureBerItem();
  const surveyTax = await surveyTaxCode();
  const outlayTax = await outlayTaxCode();
  const dueDate = surveyDueDate(job);

  // Line Amounts are VAT-INCLUSIVE (the quoted price already includes VAT + the
  // SEAI fee), so the survey line is price minus the fee, and the fee is its own
  // 0%/No-VAT line.
  const surveyAmount = round2(Math.max(0, price - SEAI_PUBLISHING_FEE));
  const line = (
    amount: number,
    description: string,
    tax?: string,
    serviceDate?: string,
  ) => {
    const detail: any = { ItemRef: { value: itemId }, Qty: 1, UnitPrice: amount };
    if (tax) detail.TaxCodeRef = { value: tax };
    if (serviceDate) detail.ServiceDate = serviceDate;
    return {
      DetailType: "SalesItemLineDetail",
      Amount: amount,
      Description: description,
      SalesItemLineDetail: detail,
    };
  };

  const invoicePayload: any = {
    Line: [
      line(surveyAmount, `BER survey of ${job.client.eircode}`, surveyTax, dueDate),
      line(SEAI_PUBLISHING_FEE, "Outlay SEAI publishing fee", outlayTax),
    ],
    CustomerRef: { value: customerId },
    BillEmail: job.client.email ? { Address: job.client.email } : undefined,
    CustomerMemo: { value: PAYMENT_MEMO },
  };
  if (dueDate) invoicePayload.DueDate = dueDate;
  if (surveyTax || outlayTax) invoicePayload.GlobalTaxCalculation = "TaxInclusive";

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
