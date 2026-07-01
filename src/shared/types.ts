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
  | "assessed" // on-site BER completed and synced back from the tablet
  | "discarded";

export type JobSource = "telegram" | "partner" | "web" | "web_admin";

export interface ClientDetails {
  name: string;
  email: string;
  phone?: string;
  eircode: string;
}

// The slice of the BER_APP `Ber` struct we can populate before the on-site
// survey. Everything else in `Ber` defaults and is filled by the assessor.
// Structured fields the client reported in the booking form are mapped here so
// the tablet can pre-fill them; the assessor confirms/overrides on-site.
export interface BerSeed {
  address: string; // client-entered address (falls back to geocoded, then eircode)
  eircode: string;
  lat?: number;
  lng?: number;
  // S3 key of the satellite/aerial image fetched at intake, framed to the
  // eircode point +50m in every direction. Seeds `Ber.site_satellite_image`.
  satelliteImageKey?: string;
  constructionYear?: number; // from details.yearBuilt
  numberOfStoreys?: number; // not captured by the form yet
  propertyType?: string; // "apartment" | "small-house" | "large-house"
  heatingSystem?: string; // client-reported heating system label
  windowYear?: number; // year windows installed
  doorYear?: number; // year doors installed
  extensions?: { year?: number; description?: string }[];
  insulation?: {
    walls?: boolean;
    roof?: boolean;
    floor?: boolean;
    notes?: string;
  };
  mprn?: string; // electricity meter number
  reason?: string; // sale | rental | grant | new-build | other
}

// The finished-assessment pointer written back by the tablet. The heavy
// `data_json` + photos live in S3 under `s3Prefix`; this row keeps a summary.
export interface BerResult {
  s3Prefix: string; // e.g. "bers/{jobId}/"
  ratingResult?: string; // e.g. "B2"
  summary?: Record<string, unknown>;
  completedAt: string; // ISO 8601
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
  invoice?: { id: string; total?: number; docNumber?: string; createdAt: string };
  loe?: { documentId: string; signingUrl?: string; status: string; createdAt: string };
  remindersSent?: string[]; // which incomplete-booking reminders were emailed ("post24h" | "daybefore")
  berSeed?: BerSeed;
  ber?: BerResult; // set when the tablet syncs the finished assessment back
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
