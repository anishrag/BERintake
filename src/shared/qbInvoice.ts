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
// client at 0% / No VAT. The quoted price is the FINAL, VAT-INCLUSIVE total — it
// already includes both the VAT and this fee.
//
// QuickBooks ignores GlobalTaxCalculation=TaxInclusive for this company, so we
// send NET amounts tax-EXCLUSIVE and let QB add the VAT back, split into two lines:
//   - "BER survey of <eircode>": net = (price - fee) / (1 + VAT rate); QB then
//     adds VAT at the standard rate (QB_TAX_CODE_ID) so line total = the
//     inclusive survey portion.
//   - "Outlay SEAI publishing fee": the flat fee at 0% / No VAT (QB_OUTLAY_TAX_CODE_ID).
const SEAI_PUBLISHING_FEE = 30;
// Standard VAT rate (percent) applied to the survey line. Override with QB_TAX_RATE.
const vatRatePercent = () => Number(process.env.QB_TAX_RATE) || 23;
const round2 = (n: number) => Math.round(n * 100) / 100;

// Pick a tax-EXCLUSIVE net so that net + QuickBooks' half-up rounded VAT lands on
// the VAT-inclusive `gross` — so the invoice total equals the quoted price with no
// stray cent. QB rounds VAT half-up (matching Math.round); we nudge the net by up
// to 2 cents to hit gross exactly, falling back to the closest cent for the rare
// gross that no 2-decimal net can reach exactly (only non-round quoted prices).
function netForInclusiveGross(gross: number, ratePct: number): number {
  const rate = ratePct / 100;
  const base = round2(gross / (1 + rate));
  let best = base;
  let bestDiff = Infinity;
  for (let cents = -2; cents <= 2; cents++) {
    const net = round2(base + cents / 100);
    const total = round2(net + round2(net * rate));
    const diff = Math.abs(total - gross);
    if (diff === 0) return net;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = net;
    }
  }
  return best;
}

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

async function ensureCustomer(
  client: ClientDetails,
  address?: string,
): Promise<string> {
  const display = `${client.name} (${client.eircode})`;
  const q = await qbQuery(`SELECT Id FROM Customer WHERE DisplayName = '${esc(display)}'`);
  const existing = q.QueryResponse?.Customer?.[0];
  if (existing) return existing.Id;

  // Billing address shown under the name on the invoice (BILL TO).
  const billAddr: Record<string, string> = { Country: "Ireland" };
  if (address) billAddr.Line1 = address;
  if (client.eircode) billAddr.PostalCode = client.eircode;

  const created = await qbPost("customer", {
    DisplayName: display,
    PrimaryEmailAddr: client.email ? { Address: client.email } : undefined,
    BillAddr: billAddr.Line1 || billAddr.PostalCode ? billAddr : undefined,
  });
  return created.Customer.Id;
}

// Find a Service item by name, creating it (posting to the first income account)
// if it doesn't exist yet.
async function ensureItem(name: string): Promise<string> {
  const q = await qbQuery(`SELECT Id FROM Item WHERE Name = '${esc(name)}'`);
  const existing = q.QueryResponse?.Item?.[0];
  if (existing) return existing.Id;

  // A Service item needs an income account to post to.
  const acc = await qbQuery(`SELECT Id FROM Account WHERE AccountType = 'Income' MAXRESULTS 1`);
  const incomeId = acc.QueryResponse?.Account?.[0]?.Id;
  if (!incomeId) throw new Error("no income account in QuickBooks to attach the item to");

  const created = await qbPost("item", {
    Name: name,
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

  const address = (job.keyDetails as { address?: string } | undefined)?.address;
  const customerId = await ensureCustomer(job.client, address);
  const berItemId = await ensureItem("BER Assessment");
  const seaiItemId = await ensureItem("SEAI Fee");
  const surveyTax = await surveyTaxCode();
  const outlayTax = await outlayTaxCode();
  const dueDate = surveyDueDate(job);

  // Amounts are sent tax-EXCLUSIVE (net); QB adds VAT on top. The survey's net is
  // chosen so net + VAT == the quoted (VAT-inclusive) survey portion, with no
  // stray cent. The SEAI fee is a flat no-VAT line.
  const surveyGross = Math.max(0, price - SEAI_PUBLISHING_FEE);
  const surveyNet = netForInclusiveGross(surveyGross, vatRatePercent());
  const line = (
    itemId: string,
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
      line(berItemId, surveyNet, `BER survey of ${job.client.eircode}`, surveyTax, dueDate),
      line(seaiItemId, SEAI_PUBLISHING_FEE, "SEAI publishing fee", outlayTax),
    ],
    CustomerRef: { value: customerId },
    BillEmail: job.client.email ? { Address: job.client.email } : undefined,
    CustomerMemo: { value: PAYMENT_MEMO },
  };
  if (dueDate) invoicePayload.DueDate = dueDate;
  if (surveyTax || outlayTax) invoicePayload.GlobalTaxCalculation = "TaxExcluded";

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
