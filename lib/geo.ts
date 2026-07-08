/**
 * Thin geodesic helpers over google.maps.geometry.spherical.
 * Only call these after the Maps JS API (with the `geometry` library) has
 * loaded.
 */

import type { LatLng } from "./types";

/** Geodesic distance between two points, metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  return google.maps.geometry.spherical.computeDistanceBetween(a, b);
}

/** Initial bearing from `a` to `b`, degrees clockwise from north. */
export function headingDeg(a: LatLng, b: LatLng): number {
  return google.maps.geometry.spherical.computeHeading(a, b);
}

/** Point `distM` metres from `from` on bearing `heading` (degrees). */
export function offsetM(from: LatLng, distM: number, heading: number): LatLng {
  const p = google.maps.geometry.spherical.computeOffset(from, distM, heading);
  return { lat: p.lat(), lng: p.lng() };
}

export function formatM(m: number | null | undefined, dp = 1): string {
  if (m == null || !Number.isFinite(m)) return "—";
  return `${m.toFixed(dp)} m`;
}
