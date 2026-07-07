// Fetches a satellite/aerial image for an eircode, framed so the image contains
// the eircode point plus ~50 m in every direction (a 100 m box).
//
// GEOCODING stays on Google (`geocodeEircode`) — that works fine. The IMAGE
// comes from MAPBOX Static Images, because Google BLOCKS satellite/hybrid Static
// Maps for EEA accounts (a `maptype=satellite` request 403s with "satellite and
// hybrid map types are not available for your account and region"). Mapbox needs
// its own token in `MAPBOX_TOKEN` (an SSM secret, loaded like the others).
// Isolated here so the provider can be swapped again without touching intake.

import { geocodeEircode } from "./pricing";

// Half-width of the frame we want guaranteed visible, in metres.
const HALF_SPAN_M = 50;
// The LOGICAL image dimension we request (px). Mapbox caps a static image at
// 1280×1280 logical px; `@2x` renders that at double DPI (2560 px raster) for
// the SAME ground coverage. Coverage in metres is `IMG_SIZE * metresPerPixel`,
// so `zoomForFrame` sizes the zoom against this exact dimension — the 100 m box
// is then genuinely contained (Google's old 640+scale split under-framed it).
const IMG_SIZE = 1280;
const MAX_ZOOM = 21; // Mapbox satellite ceiling

// Web-mercator metres-per-pixel at zoom 0, equator.
const M_PER_PX_Z0 = 156543.03392;

/**
 * Largest integer zoom whose image still spans at least `2 * HALF_SPAN_M`
 * metres across, so the target box is fully contained (with a small margin).
 * metresPerPixel(lat, zoom) = M_PER_PX_Z0 * cos(lat) / 2^zoom.
 */
export function zoomForFrame(lat: number): number {
  const effectivePx = IMG_SIZE;
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
  const token = process.env.MAPBOX_TOKEN;
  if (!token) {
    console.warn("MAPBOX_TOKEN not set — cannot fetch satellite image");
    return null;
  }

  // Geocode via Google (works); only the imagery moves to Mapbox.
  const geo = await geocodeEircode(eircode);
  if (!geo) return null;

  const zoom = zoomForFrame(geo.lat);
  // Mapbox Static Images API — centre is {lon},{lat},{zoom}; `@2x` is high-DPI.
  const url =
    `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
    `${geo.lng},${geo.lat},${zoom}/${IMG_SIZE}x${IMG_SIZE}@2x` +
    `?access_token=${encodeURIComponent(token)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`mapbox static image for ${eircode} returned ${res.status}`);
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      // Mapbox returns a JSON error body on auth/rate errors — guard anyway.
      console.warn(`mapbox image for ${eircode} was not an image: ${contentType}`);
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
    console.error("mapbox static image fetch error", err);
    return null;
  }
}
