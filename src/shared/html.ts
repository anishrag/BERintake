// Escape a user-supplied value for safe interpolation into HTML (client emails)
// and Telegram parse_mode=HTML messages. Values here only ever land in element/
// text content, so escaping & < > is sufficient.
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
