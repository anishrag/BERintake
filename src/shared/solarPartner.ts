// The solar-referral partner: jobs created via /newsolar are billed to this
// company instead of the homeowner. Configured in secrets/solar.env (read by
// scripts/deploy.py into stack parameters → Lambda env vars), so the partner
// can change without touching code.

import type { Job } from "./types";

export interface SolarPartner {
  name: string;
  address?: string;
  email?: string;
}

export function solarPartner(): SolarPartner {
  const trimmed = (v?: string) => {
    const t = (v ?? "").trim();
    return t === "" ? undefined : t;
  };
  return {
    name: trimmed(process.env.SOLAR_PARTNER_NAME) ?? "our solar partner",
    address: trimmed(process.env.SOLAR_PARTNER_ADDRESS),
    email: trimmed(process.env.SOLAR_PARTNER_EMAIL),
  };
}

/** A job whose invoice goes to the solar partner, not the client. */
export function isSolarJob(job: Job): boolean {
  return job.billTo === "solar_partner";
}

// The partner-agreed price table (solar.env) — the same zone x property-type
// shape as the public pricing in pricing.ts, but with the partner's rates.
// Solar jobs are priced ONLY from this table, never from the public prices.
// Unlike the public prices these are EX VAT: the figure is the invoice's
// survey net (QB adds VAT), and the SEAI fee goes on top as its own line.
//
// Env format: SOLAR_PRICE_<ZONE> = "apartment/small-house/large-house", e.g.
// SOLAR_PRICE_PRIMARY=250/270/300. SOLAR_PRICE_OUTSIDE is one flat price.

const num = (v?: string): number | undefined => {
  const n = Number((v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function zoneTier(zone: string): Record<string, number> | undefined {
  const raw = process.env[`SOLAR_PRICE_${zone.toUpperCase()}`];
  const parts = (raw ?? "").split("/").map((p) => num(p));
  if (parts.length !== 3 || parts.some((p) => p === undefined)) return undefined;
  return {
    apartment: parts[0]!,
    "small-house": parts[1]!,
    "large-house": parts[2]!,
  };
}

/** The partner price for a job, or undefined if the table isn't configured. */
export function solarPriceFor(
  serviceArea: string | undefined,
  propertyType: string | undefined,
): number | undefined {
  if (!serviceArea || !propertyType) return undefined;
  if (serviceArea === "outside") return num(process.env.SOLAR_PRICE_OUTSIDE);
  return zoneTier(serviceArea)?.[propertyType];
}

/**
 * The discount deal agreed with the partner (solar.env): `amount` € (ex VAT)
 * off each of the next `total` invoices. `alreadyUsed` seeds the DynamoDB
 * counter the first time a discount is claimed (discounts given before the
 * counter existed); after that the live count is authoritative.
 */
export function solarDiscount():
  | { amount: number; total: number; alreadyUsed: number }
  | undefined {
  const amount = num(process.env.SOLAR_DISCOUNT_AMOUNT);
  const total = num(process.env.SOLAR_DISCOUNT_TOTAL);
  if (!amount || !total) return undefined;
  const alreadyUsed = num(process.env.SOLAR_DISCOUNT_ALREADY_USED) ?? 0;
  return { amount, total, alreadyUsed };
}

export function solarPricesConfigured(): boolean {
  return (
    ["primary", "secondary", "tertiary"].every((z) => zoneTier(z) !== undefined) &&
    num(process.env.SOLAR_PRICE_OUTSIDE) !== undefined
  );
}
