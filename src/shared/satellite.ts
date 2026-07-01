// Fetches a satellite/aerial image for an eircode, framed so the image contains
// the eircode point plus ~50 m in every direction (a 100 m box). Provider is
// Google Static Maps, reusing the same GOOGLE_MAPS_API_KEY the pricing geocoder
// already uses. Isolated here so the provider can be swapped (Mapbox, Tailte
// Éireann GeoHive) without touching the intake flow.

import { geocodeEircode } from "./pricing";

// Half-width of the frame we want guaranteed visible, in metres.
const HALF_SPAN_M = 50;
// Google Static Maps hard cap on non-premium image dimensions is 640px; scale=2
// doubles the returned pixels (and thus resolution) for the same ground area.
const IMG_SIZE = 640;
const IMG_SCALE = 2;
const MAX_ZOOM = 21; // Google satellite ceiling

// Web-mercator metres-per-pixel at zoom 0, equator.
const M_PER_PX_Z0 = 156543.03392;

/**
 * Largest integer zoom whose image still spans at least `2 * HALF_SPAN_M`
 * metres across, so the target box is fully contained (with a small margin).
 * metresPerPixel(lat, zoom) = M_PER_PX_Z0 * cos(lat) / 2^zoom.
 */
export function zoomForFrame(lat: number): number {
  const effectivePx = IMG_SIZE * IMG_SCALE;
  const targetSpanM = 2 * HALF_SPAN_M;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (let zoom = MAX_ZOOM; zoom >= 1; zoom--) {
    const mPerPx = (M_PER_PX_Z0 * cosLat) / 2 ** zoom;
    if (effectivePx * mPerPx >= targetSpanM) return zoom;
  }
  return 1;
}

export interface SatelliteImage {
  buffer: Buffer;
  contentType: string;
  lat: number;
  lng: number;
  zoom: number;
  formattedAddress?: string;
}

/**
 * Geocode the eircode and fetch its satellite image. Returns null (never throws)
 * if the key is missing, geocoding fails, or the image fetch fails — callers
 * treat the seed's imagery as best-effort.
 */
export async function fetchSatelliteImage(
  eircode: string,
): Promise<SatelliteImage | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn("GOOGLE_MAPS_API_KEY not set — cannot fetch satellite image");
    return null;
  }

  const geo = await geocodeEircode(eircode);
  if (!geo) return null;

  const zoom = zoomForFrame(geo.lat);
  const url =
    `https://maps.googleapis.com/maps/api/staticmap?center=${geo.lat},${geo.lng}` +
    `&zoom=${zoom}&size=${IMG_SIZE}x${IMG_SIZE}&scale=${IMG_SCALE}` +
    `&maptype=satellite&format=jpg&key=${key}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`static map fetch for ${eircode} returned ${res.status}`);
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      // Google returns a text/plain error body (e.g. quota) with HTTP 200.
      console.warn(`static map for ${eircode} was not an image: ${contentType}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      buffer,
      contentType,
      lat: geo.lat,
      lng: geo.lng,
      zoom,
      formattedAddress: geo.formattedAddress,
    };
  } catch (err) {
    console.error("static map fetch error", err);
    return null;
  }
}
