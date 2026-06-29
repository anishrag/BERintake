// Canonical contract for a job as it moves through the intake funnel.
// This shape (especially `berSeed`) is what BER_APP eventually pulls and
// seeds into its local SQLite `ber` row.

export type JobStatus =
  | "pending_review" // partner-submitted, awaiting owner approval on Telegram
  | "quote_sent" // client emailed the quote link
  | "quoted" // client filled quote details
  | "booked" // date picked
  | "paid" // Revolut payment confirmed
  | "signed" // letter of engagement e-signed
  | "confirmed" // paid + signed: ready for the assessor
  | "pulled" // synced into BER_APP on the tablet
  | "discarded";

export type JobSource = "telegram" | "partner" | "web_admin";

export interface ClientDetails {
  name: string;
  email: string;
  phone?: string;
  eircode: string;
}

// The slice of the BER_APP `Ber` struct we can populate before the on-site
// survey. Everything else in `Ber` defaults and is filled by the assessor.
export interface BerSeed {
  address: string;
  eircode: string;
  constructionYear?: number;
  numberOfStoreys?: number;
}

export interface Job {
  jobId: string;
  token: string; // unguessable id used in the client-facing URL
  status: JobStatus;
  source: JobSource;
  partnerName?: string; // set when source === "partner" (referral tracking)
  note?: string;
  client: ClientDetails;
  // Tentative slot reservation while the client fills the booking form.
  hold?: { eventId: string; holdUntil: string };
  // Computed once from the eircode (geocode → zone), cached for the quote page.
  serviceArea?: string;
  quotePrices?: Record<string, number>; // house type -> price for this zone
  quote?: Record<string, unknown>;
  booking?: Record<string, unknown>;
  payment?: Record<string, unknown>;
  signature?: Record<string, unknown>;
  keyDetails?: Record<string, unknown>;
  berSeed?: BerSeed;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
