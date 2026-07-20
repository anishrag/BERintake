// Canonical contract for a job as it moves through the intake funnel.
// This shape (especially `berSeed`) is what BER_APP eventually pulls and
// seeds into its local SQLite `ber` row.

export type JobStatus =
  | "pending_review" // partner-submitted, awaiting owner approval on Telegram
  | "quote_sent" // client emailed the quote link
  | "quoted" // client filled quote details
  | "prebooked" // Telegram pre-agreed slot set by the owner; client hasn't filled the form yet
  | "booked" // date picked / client completed the booking form
  | "paid" // Revolut payment confirmed
  | "signed" // letter of engagement e-signed
  | "confirmed" // paid + signed: ready for the assessor
  | "pulled" // synced into BER_APP on the tablet
  | "surveyed" // on-site BER completed and synced back from the tablet
  | "details_requested" // surveyed, details requested: office asked the client for the extra info/docs needed to resolve unknowns
  | "details_provided" // surveyed, details provided: client supplied them — the state `resolve` runs on
  | "resolved" // office `resolve` complete: unknown constructions clarified and justifying documents attached
  | "report_generated" // DEAP report produced from the resolved survey
  | "published" // report lodged/published to the client (and SEAI)
  | "done" // job fully complete — nothing further to do
  | "discarded";

// "tablet" = registered by the assessor's tablet for a BER created from
// scratch on-site (no intake funnel; lands directly as `pulled`).
export type JobSource = "telegram" | "partner" | "web" | "web_admin" | "tablet";

// Why a client-driven booking needs the owner's confirmation before it commits.
// "post-works" — the client claims we did their pre-works BER (we can't verify).
// "outside-zone" — the property geocodes outside our service areas.
export type ConfirmReason = "post-works" | "outside-zone";

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

// A bug report uploaded by the BER_APP tablet: an audio recording + a JSON
// state dump + metadata. The heavy blobs live in S3 under `bug-reports/{id}/`;
// this row is the queryable record. Marked "fixed" later from home.
export interface BugReport {
  bugReportId: string;
  createdAt: string; // ISO 8601
  status: "open" | "fixed";
  note?: string;
  berId?: string; // the BER the report was raised against, if any
  address?: string;
  appContext?: Record<string, string>; // page / appVersion / deviceModel etc.
  audioKey?: string; // S3 key of the audio recording (only when hasAudio)
  stateKey: string; // S3 key of the JSON state dump
  hasAudio: boolean;
  uploadedAt?: string; // set when the tablet confirms the blobs are uploaded
  fixedAt?: string; // set when marked fixed from home
}

export interface Job {
  jobId: string;
  token: string; // unguessable id used in the client-facing URL
  status: JobStatus;
  source: JobSource;
  // Which billing pipeline the job follows. Absent = the client pays (default).
  // "solar_partner" = created via /newsolar: the client pays nothing and the
  // solar partner (shared/solarPartner.ts) is invoiced instead.
  // "auctioneera" = the client already paid Auctioneera in full; the invoice
  // (shown to the client) deducts Auctioneera's commission.
  billTo?: "solar_partner" | "auctioneera";
  partnerName?: string; // set when source === "partner" (referral tracking)
  note?: string;
  postWorks?: boolean; // client claims a post-works BER (pre-works done by us <6 months ago) → -€200
  client: ClientDetails;
  // Tentative slot reservation while the client fills the booking form.
  hold?: { eventId: string; holdUntil: string };
  // Computed once from the eircode (geocode → zone), cached for the quote page.
  serviceArea?: string;
  quotePrices?: Record<string, number>; // house type -> price for this zone
  agreedPrice?: number; // trusted owner/contractor-set price; overrides the zone price
  quote?: Record<string, unknown>;
  booking?: Record<string, unknown>;
  payment?: Record<string, unknown>;
  signature?: Record<string, unknown>;
  keyDetails?: Record<string, unknown>;
  invoice?: { id: string; total?: number; docNumber?: string; createdAt: string };
  loe?: { documentId: string; signingUrl?: string; status: string; createdAt: string };
  // Owner-confirmation gate for client-driven bookings that need a manual check
  // before anything commits (an invoice, LoE, or calendar booking): a post-works
  // claim we can't verify, or an address outside our service zones. See
  // shared/confirmation.ts. Absent = never gated (proceeds freely).
  confirmGate?: {
    reasons: ConfirmReason[]; // why confirmation is needed
    status: "pending" | "approved" | "rejected";
    notifiedAt: string; // when the owner was pinged on Telegram
    decidedAt?: string; // when the owner confirmed / rejected
  };
  sentEmails?: string[]; // which deferred funnel emails were sent ("quote" | "loe_nudge" | "save_for_later")
  berSeed?: BerSeed;
  ber?: BerResult; // set when the tablet syncs the finished assessment back
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
