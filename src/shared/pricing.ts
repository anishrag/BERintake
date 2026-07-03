// Server-side quote pricing: geocode the eircode (Google), find which service
// zone it falls in, and read the price off the tier table. Ported from the
// website's pricing.js + priceCalculator.js so a client gets a real price on
// the web without depending on the site's local Express server.

import { A98_PRIMARY, A98_SECONDARY } from "./a98Zones";

export type HouseType = "apartment" | "small-house" | "large-house";
export type ServiceArea = "primary" | "secondary" | "tertiary" | "outside";

type Tier = Record<HouseType, number> & { default: number };

const pricing: Record<"primary" | "secondary" | "tertiary", Tier> & {
  outside: number;
} = {
  primary: { apartment: 250, "small-house": 270, "large-house": 300, default: 300 },
  secondary: { apartment: 270, "small-house": 300, "large-house": 320, default: 350 },
  tertiary: { apartment: 290, "small-house": 320, "large-house": 350, default: 400 },
  outside: 400,
};

type LngLat = { lng: number; lat: number };

export const serviceAreaPolygons: Record<
  "primaryArea" | "secondaryArea" | "tertiaryArea",
  LngLat[]
> = {
  primaryArea: [
    { lng: -6.1021402, lat: 53.2673816 },
    { lng: -6.2367228, lat: 53.2575244 },
    { lng: -6.1966881, lat: 53.1098261 },
    { lng: -6.0408195, lat: 53.1188932 },
    { lng: -6.0497459, lat: 53.133726 },
    { lng: -6.0621055, lat: 53.1469065 },
    { lng: -6.0740013, lat: 53.1592507 },
    { lng: -6.0781212, lat: 53.1670724 },
    { lng: -6.0710319, lat: 53.1749015 },
    { lng: -6.080645, lat: 53.1917721 },
    { lng: -6.0895714, lat: 53.1950631 },
    { lng: -6.0939005, lat: 53.1993617 },
    { lng: -6.1007805, lat: 53.2078047 },
    { lng: -6.1045435, lat: 53.2168393 },
    { lng: -6.1079767, lat: 53.2314328 },
    { lng: -6.11141, lat: 53.2371867 },
    { lng: -6.1117533, lat: 53.2577297 },
    { lng: -6.1021402, lat: 53.2673816 },
  ],
  secondaryArea: [
    { lng: -6.0485955, lat: 53.0347348 },
    { lng: -6.0431023, lat: 53.0500094 },
    { lng: -6.0362358, lat: 53.0665165 },
    { lng: -6.0341759, lat: 53.0731175 },
    { lng: -6.0362358, lat: 53.0879661 },
    { lng: -6.0389824, lat: 53.1036341 },
    { lng: -6.0403557, lat: 53.111466 },
    { lng: -6.0408195, lat: 53.1188932 },
    { lng: -6.1966881, lat: 53.1098261 },
    { lng: -6.2367228, lat: 53.2575244 },
    { lng: -6.1021402, lat: 53.2673816 },
    { lng: -6.0911675, lat: 53.2706786 },
    { lng: -6.0932274, lat: 53.2756059 },
    { lng: -6.1042137, lat: 53.285459 },
    { lng: -6.1117668, lat: 53.2887428 },
    { lng: -6.1193199, lat: 53.2887428 },
    { lng: -6.1303063, lat: 53.2957202 },
    { lng: -6.1364861, lat: 53.2961306 },
    { lng: -6.1605187, lat: 53.2969513 },
    { lng: -6.1694451, lat: 53.2998239 },
    { lng: -6.1804314, lat: 53.3031067 },
    { lng: -6.1914177, lat: 53.3080303 },
    { lng: -6.1969109, lat: 53.3100817 },
    { lng: -6.2024041, lat: 53.3154147 },
    { lng: -6.2072106, lat: 53.3215674 },
    { lng: -6.2072106, lat: 53.3273091 },
    { lng: -6.310894, lat: 53.3063892 },
    { lng: -6.2408562, lat: 53.0677542 },
    { lng: -6.2360497, lat: 53.0467073 },
    { lng: -6.0485955, lat: 53.0347348 },
  ],
  tertiaryArea: [
    { lng: -6.2236901, lat: 53.3469891 },
    { lng: -6.3678856, lat: 53.3961493 },
    { lng: -6.4598961, lat: 53.3428898 },
    { lng: -6.3747521, lat: 53.3018757 },
    { lng: -6.345913, lat: 52.9748226 },
    { lng: -6.0245629, lat: 52.9748226 },
    { lng: -6.0479088, lat: 52.9897051 },
    { lng: -6.0506554, lat: 52.9996239 },
    { lng: -6.0485955, lat: 53.0347348 },
    { lng: -6.2360497, lat: 53.0467073 },
    { lng: -6.310894, lat: 53.3063892 },
    { lng: -6.2072106, lat: 53.3273091 },
    { lng: -6.2017174, lat: 53.3346902 },
    { lng: -6.1824913, lat: 53.3404301 },
    { lng: -6.2236901, lat: 53.3469891 },
  ],
};

function isPointInPolygon(lat: number, lng: number, polygon: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function determineServiceArea(lat: number, lng: number): ServiceArea {
  if (isPointInPolygon(lat, lng, serviceAreaPolygons.primaryArea)) return "primary";
  if (isPointInPolygon(lat, lng, serviceAreaPolygons.secondaryArea)) return "secondary";
  if (isPointInPolygon(lat, lng, serviceAreaPolygons.tertiaryArea)) return "tertiary";
  return "outside";
}

export function pricesForArea(area: ServiceArea): Record<HouseType, number> {
  if (area === "outside") {
    return {
      apartment: pricing.outside,
      "small-house": pricing.outside,
      "large-house": pricing.outside,
    };
  }
  const tier = pricing[area];
  return {
    apartment: tier.apartment,
    "small-house": tier["small-house"],
    "large-house": tier["large-house"],
  };
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress?: string;
}

export async function geocodeEircode(
  eircode: string,
): Promise<GeocodeResult | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn("GOOGLE_MAPS_API_KEY not set — cannot geocode for pricing");
    return null;
  }
  try {
    // Bias to Ireland — a bare eircode often fails to geocode on its own.
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        `${eircode}, Ireland`,
      )}&region=ie&components=country:IE&key=${key}`;
    const res = await fetch(url);
    const data: any = await res.json();
    if (data.status === "OK" && data.results?.length > 0) {
      const { lat, lng } = data.results[0].geometry.location;
      return { lat, lng, formattedAddress: data.results[0].formatted_address };
    }
    console.warn(`geocode for ${eircode} returned ${data.status}`);
    return null;
  } catch (err) {
    console.error("geocode error", err);
    return null;
  }
}

/** Geocode → zone → per-house-type prices. Null if geocoding is unavailable. */
// Zone by eircode routing key (first 3 chars) — avoids geocoding entirely for
// the areas we serve. Anything NOT listed here is treated as "outside" (no
// geocode). Only the boundary keys in GEOCODE_KEYS fall through to a precise
// geocode. To add a new served area, just add its routing key below.
export const ROUTING_KEY_ZONES: Record<string, ServiceArea> = {
  // Primary is only (part of) A98 (Bray core) — resolved live via geocode below.
  A63: "secondary",
  D18: "secondary",
  D16: "secondary",
  A96: "secondary",
  D14: "tertiary",
  A94: "tertiary",
  D06: "tertiary",
  D6W: "tertiary",
  D24: "tertiary",
  A67: "tertiary",
  D04: "tertiary",
  D08: "tertiary",
  D12: "tertiary",
};

// Routing keys that straddle a zone boundary — geocode these for precision.
const GEOCODE_KEYS = new Set(["A98"]);

function routingKey(eircode: string): string {
  return eircode.replace(/\s+/g, "").toUpperCase().slice(0, 3);
}

/** Whether this eircode needs a (paid) geocode rather than a routing-key lookup. */
export function needsGeocode(eircode: string): boolean {
  return GEOCODE_KEYS.has(routingKey(eircode));
}

/** Zone from the routing key, or undefined if it needs a precise geocode. */
function zoneFromRoutingKey(eircode: string): ServiceArea | undefined {
  const key = routingKey(eircode);
  if (GEOCODE_KEYS.has(key)) return undefined;
  return ROUTING_KEY_ZONES[key] ?? "outside";
}

export async function computeQuotePricing(
  eircode: string,
): Promise<{ serviceArea: ServiceArea; prices: Record<HouseType, number> } | null> {
  // Fast path: routing-key lookup, no geocoding (covers all but boundary keys).
  const direct = zoneFromRoutingKey(eircode.trim());
  if (direct) return { serviceArea: direct, prices: pricesForArea(direct) };

  // Boundary key (A98): geocode, then classify into the A98 sub-zones
  // (primary Bray core / secondary valley / tertiary mountains+south).
  const coords = await geocodeEircode(eircode.trim());
  if (!coords) return { serviceArea: "secondary", prices: pricesForArea("secondary") };
  const serviceArea = a98Zone(coords.lat, coords.lng);
  return { serviceArea, prices: pricesForArea(serviceArea) };
}

function a98Zone(lat: number, lng: number): ServiceArea {
  if (isPointInPolygon(lat, lng, A98_PRIMARY)) return "primary";
  if (isPointInPolygon(lat, lng, A98_SECONDARY)) return "secondary";
  return "tertiary";
}
