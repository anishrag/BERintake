// Google Calendar access from Lambda — reuses the website's Google app and the
// "Slot Available" event model. Uses the refresh-token grant + Calendar REST
// API directly (no googleapis SDK) to keep the bundle small and stateless.

interface Slot {
  id: string;
  start: string; // ISO
  end: string; // ISO
}

let cached: { token: string; exp: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.exp > now + 60_000) return cached.token;

  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN ?? "",
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`google token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data: any = await res.json();
  cached = {
    token: data.access_token,
    exp: now + (data.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

const calPath = () =>
  encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || "primary");

const SLOT_MARKER = "Slot Available";

/** Available booking slots — calendar events whose title contains "Slot Available". */
export async function listSlots(): Promise<Slot[]> {
  const token = await getAccessToken();
  const qs = new URLSearchParams({
    timeMin: new Date().toISOString(),
    maxResults: "50",
    singleEvents: "true",
    orderBy: "startTime",
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calPath()}/events?${qs}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`calendar list failed: ${res.status}`);
  const data: any = await res.json();
  return (data.items ?? [])
    .filter((e: any) => (e.summary ?? "").includes(SLOT_MARKER))
    .map((e: any) => ({
      id: e.id,
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
    }));
}

export async function getEvent(eventId: string): Promise<any | null> {
  const token = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calPath()}/events/${encodeURIComponent(
      eventId,
    )}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  return res.json();
}

/** True if the event is still an open "Slot Available" (not already taken). */
export function isOpenSlot(event: any): boolean {
  return typeof event?.summary === "string" && event.summary.includes(SLOT_MARKER);
}

/**
 * Create a new booked event at a specific local Irish time (pre-agreed via
 * Telegram /newclient). `startNaive`/`endNaive` are "YYYY-MM-DDTHH:MM:00"
 * with no offset — Google interprets them in the given time zone.
 */
export async function createBookedEvent(
  summary: string,
  startNaive: string,
  endNaive: string,
): Promise<{ id: string; start: string; end: string }> {
  const token = await getAccessToken();
  const tz = "Europe/Dublin";
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calPath()}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        summary,
        start: { dateTime: startNaive, timeZone: tz },
        end: { dateTime: endNaive, timeZone: tz },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`calendar create failed: ${res.status} ${await res.text()}`);
  }
  const e: any = await res.json();
  return {
    id: e.id,
    start: e.start?.dateTime ?? startNaive,
    end: e.end?.dateTime ?? endNaive,
  };
}

/** Rename the event to mark it booked. */
export async function bookSlot(eventId: string, summary: string): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calPath()}/events/${encodeURIComponent(
      eventId,
    )}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ summary }),
    },
  );
  if (!res.ok) {
    throw new Error(`calendar patch failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
