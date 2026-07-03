// Cannygreen Limited — company particulars for CRO / Revenue disclosure.
// Client-facing emails are electronic "business letters", so these appear as a
// footer on every one (added centrally in email.ts). Single source of truth.

export const COMPANY = {
  name: "Cannygreen Limited",
  croNumber: "768386", // CRO registered number
  registeredOffice: "168 Charnwood, Bray, Co. Wicklow, A98 FX46",
  director: "Anish Raghavan",
  vatNumber: "IE4318730AH",
  seaiAssessorNumber: "109784",
  seaiCompanyNumber: "109785",
} as const;

export const emailFooterText = `—
${COMPANY.name} — a private company registered in Ireland, Company No. ${COMPANY.croNumber}.
Registered office: ${COMPANY.registeredOffice}. Director: ${COMPANY.director}.
VAT No. ${COMPANY.vatNumber} · SEAI BER Assessor No. ${COMPANY.seaiAssessorNumber}.`;

export const emailFooterHtml = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;line-height:1.5;color:#888;max-width:560px;margin-top:18px;border-top:1px solid #e6ece6;padding-top:10px">
  <strong>${COMPANY.name}</strong> — a private company registered in Ireland, Company No. ${COMPANY.croNumber}.<br>
  Registered office: ${COMPANY.registeredOffice}. Director: ${COMPANY.director}.<br>
  VAT No. ${COMPANY.vatNumber} &middot; SEAI BER Assessor No. ${COMPANY.seaiAssessorNumber}.
</div>`;
