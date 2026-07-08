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

/**
 * Closest point on the segment a→b to an arbitrary point p, clamped to the
 * segment. Used to snap a map click onto a splay sightline so Street View can
 * be dropped in "along the line". Planar approximation via the along-segment
 * projection of the geodesic offset — accurate at junction scales.
 */
export function projectOntoSegment(
  a: LatLng,
  b: LatLng,
  p: LatLng
): { point: LatLng; alongM: number; segLenM: number } {
  const segLenM = distanceM(a, b);
  if (segLenM === 0) return { point: a, alongM: 0, segLenM: 0 };
  const hAB = headingDeg(a, b);
  const hAP = headingDeg(a, p);
  const dAP = distanceM(a, p);
  const along = dAP * Math.cos(((hAP - hAB) * Math.PI) / 180);
  const clamped = Math.max(0, Math.min(segLenM, along));
  return { point: offsetM(a, clamped, hAB), alongM: clamped, segLenM };
}

/** Parse a Street View `imageDate` ("YYYY-MM" or "YYYY") for display + staleness. */
export function parseImageDate(
  s: string | null | undefined
): { label: string; stale: boolean; ageYears: number } | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return { label: s, stale: false, ageYears: 0 };
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : 1;
  const d = new Date(year, month - 1, 1);
  const ageYears = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
  const label = d.toLocaleDateString("en-GB", {
    month: m[2] ? "short" : undefined,
    year: "numeric",
  });
  return { label, stale: ageYears > 2, ageYears };
}
