// Build QuickBooks invoices for a job: ensure a Customer + a "BER Assessment"
// service item exist, then create the invoice and fetch its PDF.

import {
  claimSolarDiscount,
  releaseSolarDiscount,
  resolveJobPrice,
  setInvoice,
} from "./jobs";
import { qbFetch } from "./quickbooks";
import { isSolarJob, solarDiscount, solarPartner } from "./solarPartner";
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
// Auctioneera referrals: their commission, as a fraction of the EX-VAT survey
// fee (the SEAI fee is excluded from the base). Deducted on the invoice as a
// negative line that carries standard VAT itself.
const AUCTIONEERA_COMMISSION_RATE = 0.15;
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
  const name = (client.name || "").trim() || "Client";
  const display = `${name} (${client.eircode})`;
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

// The QuickBooks customer for the solar partner — /newsolar invoices bill this
// company, not the homeowner. One shared customer across all solar jobs.
async function ensureSolarPartnerCustomer(): Promise<string> {
  const partner = solarPartner();
  const q = await qbQuery(
    `SELECT Id FROM Customer WHERE DisplayName = '${esc(partner.name)}'`,
  );
  const existing = q.QueryResponse?.Customer?.[0];
  if (existing) return existing.Id;

  const created = await qbPost("customer", {
    DisplayName: partner.name,
    PrimaryEmailAddr: partner.email ? { Address: partner.email } : undefined,
    BillAddr: partner.address
      ? { Line1: partner.address, Country: "Ireland" }
      : undefined,
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

  // Solar-partner jobs bill the partner company; everything else the client.
  const solar = isSolarJob(job);
  const address = (job.keyDetails as { address?: string } | undefined)?.address;
  const customerId = solar
    ? await ensureSolarPartnerCustomer()
    : await ensureCustomer(job.client, address);
  const billEmail = solar ? solarPartner().email : job.client.email;
  const berItemId = await ensureItem("BER Assessment");
  const seaiItemId = await ensureItem("SEAI Fee");
  const surveyTax = await surveyTaxCode();
  const outlayTax = await outlayTaxCode();
  const dueDate = surveyDueDate(job);

  // Amounts are sent tax-EXCLUSIVE (net); QB adds VAT on top. The SEAI fee is
  // a flat no-VAT line in both cases.
  //  - Client-billed: the quoted price is the FINAL total (VAT and SEAI fee
  //    included) — back-calculate the survey net so the invoice lands on it
  //    with no stray cent.
  //  - Solar-partner: the table price (solar.env) is the survey fee EX VAT —
  //    it IS the net, and the SEAI fee goes on top.
  const surveyNet = solar
    ? round2(price)
    : netForInclusiveGross(
        Math.max(0, price - SEAI_PUBLISHING_FEE),
        vatRatePercent(),
      );
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

  // On a partner-billed invoice the line must identify WHOSE property was
  // surveyed — the partner sees many of these.
  const who = [job.client.name, address].filter(Boolean).join(", ");
  // Auctioneera jobs may be created before the eircode is known — fall back to
  // the form address rather than an empty description.
  const site = job.client.eircode || address || "the property";
  const surveyDesc =
    solar && who
      ? `BER survey of ${who} (${job.client.eircode})`
      : `BER survey of ${site}`;
  // Every line carries the SAME service date: QuickBooks' PDF template sorts
  // lines by service date (undated lines first), so a lone dated line ignores
  // LineNum and sinks to the bottom. Equal dates make LineNum the tiebreaker.
  const lines = [
    line(berItemId, surveyNet, surveyDesc, surveyTax, dueDate),
    line(seaiItemId, SEAI_PUBLISHING_FEE, "SEAI publishing fee", outlayTax, dueDate),
  ];
  let memo = PAYMENT_MEMO;

  // Auctioneera referral: the client already paid Auctioneera the full quoted
  // price, so no payment is due on this invoice — it documents the fee and
  // deducts Auctioneera's commission (15% of the ex-VAT survey fee, itself
  // carrying standard VAT). The total is what Auctioneera remits to us.
  if (job.billTo === "auctioneera") {
    const commissionNet = round2(AUCTIONEERA_COMMISSION_RATE * surveyNet);
    const commissionItemId = await ensureItem("Auctioneera Commission");
    lines.push(
      line(
        commissionItemId,
        -commissionNet,
        `Auctioneera commission (${AUCTIONEERA_COMMISSION_RATE * 100}% of the ex-VAT survey fee)`,
        surveyTax,
        dueDate,
      ),
    );
    memo = "Paid in full via Auctioneera — no payment is due.";
  }

  // Partner discount deal (solar.env): −€amount (standard VAT applies, so the
  // VAT shrinks too) on each of the agreed number of invoices, tracked by an
  // atomic counter. The item is ensured BEFORE claiming so the claim→create
  // window stays minimal; a failed create hands the claim back below.
  const dealConfigured = solar && solarDiscount() !== undefined;
  const discountItemId = dealConfigured
    ? await ensureItem("Partner Discount")
    : undefined;
  const discount = dealConfigured ? await claimSolarDiscount() : undefined;
  if (discount && discountItemId) {
    const label = `€${discount.amount} discount for next ${discount.total} BERs (${discount.seq}/${discount.total})`;
    lines.push(line(discountItemId, -discount.amount, label, surveyTax, dueDate));
    memo = `${label}\n\n${PAYMENT_MEMO}`;
  }

  // Explicit LineNum pins the display order (survey → SEAI fee → any
  // commission/discount) — without it QuickBooks may reorder lines on the PDF.
  lines.forEach((l: any, i) => {
    l.LineNum = i + 1;
  });

  const invoicePayload: any = {
    Line: lines,
    CustomerRef: { value: customerId },
    BillEmail: billEmail ? { Address: billEmail } : undefined,
    CustomerMemo: { value: memo },
  };
  if (dueDate) invoicePayload.DueDate = dueDate;
  if (surveyTax || outlayTax) invoicePayload.GlobalTaxCalculation = "TaxExcluded";

  let created: any;
  try {
    created = await qbPost("invoice", invoicePayload);
  } catch (err) {
    if (discount) await releaseSolarDiscount();
    throw err;
  }

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
