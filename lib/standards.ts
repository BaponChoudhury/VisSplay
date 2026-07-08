/**
 * Engineering standards data for visibility splay assessment.
 *
 * Sources (provisional values supplied by the commissioning engineer):
 *  - Manual for Streets (DfT, 2007) Table 7.1 / Manual for Streets 2 (CIHT,
 *    2010) — Stopping Sight Distances for streets up to 60 kph (37 mph).
 *  - DMRB CD 109 "Highway link design" (National Highways) — SSD by design
 *    speed for higher-speed roads.
 *
 * TODO: verify against MfS Table 7.1 and CD 109
 *
 * All values are user-overridable in the UI; never hardcode standards values
 * inside components — import from this file only.
 */

import type { StandardId } from "./types";

export const KPH_PER_MPH = 1.609344;

export function kphToMph(kph: number): number {
  return kph / KPH_PER_MPH;
}

export function mphToKph(mph: number): number {
  return mph * KPH_PER_MPH;
}

export interface SsdRow {
  /** Speed in kph (MfS: street speed; CD 109: design speed). */
  kph: number;
  /** Nominal mph equivalent shown in UK guidance tables (display only). */
  mph: number | null;
  /** Stopping Sight Distance = required Y distance, metres. */
  ssd: number;
}

/** Manual for Streets / MfS2 — use for streets ≤ 60 kph (37 mph). */
export const MFS_SSD_TABLE: SsdRow[] = [
  { kph: 16, mph: 10, ssd: 12 },
  { kph: 24, mph: 15, ssd: 17 },
  { kph: 32, mph: 20, ssd: 25 },
  { kph: 40, mph: 25, ssd: 33 },
  { kph: 48, mph: 30, ssd: 43 },
  { kph: 60, mph: 37, ssd: 59 },
];

/** DMRB CD 109 — use for higher-speed roads, by design speed. */
export const CD109_SSD_TABLE: SsdRow[] = [
  { kph: 50, mph: null, ssd: 70 },
  { kph: 60, mph: null, ssd: 90 },
  { kph: 70, mph: null, ssd: 120 },
  { kph: 85, mph: null, ssd: 160 },
  { kph: 100, mph: null, ssd: 215 },
  { kph: 120, mph: null, ssd: 295 },
];

export function tableFor(standard: StandardId): SsdRow[] | null {
  if (standard === "mfs") return MFS_SSD_TABLE;
  if (standard === "cd109") return CD109_SSD_TABLE;
  return null; // manual — engineer types Y directly
}

export interface SsdResult {
  ssd: number;
  /** True when speed fell outside the table and the end value was clamped. */
  clamped: boolean;
  /** True when linearly interpolated between two table rows. */
  interpolated: boolean;
}

/**
 * Required Y (SSD) for a speed in kph, with linear interpolation between
 * table speeds. Speeds outside the table range are clamped to the end values
 * and flagged so the UI can warn.
 */
export function ssdForSpeed(
  standard: StandardId,
  speedKph: number
): SsdResult | null {
  const table = tableFor(standard);
  if (!table || !Number.isFinite(speedKph) || speedKph <= 0) return null;

  const first = table[0];
  const last = table[table.length - 1];
  if (speedKph <= first.kph) {
    return { ssd: first.ssd, clamped: speedKph < first.kph, interpolated: false };
  }
  if (speedKph >= last.kph) {
    return { ssd: last.ssd, clamped: speedKph > last.kph, interpolated: false };
  }
  for (let i = 0; i < table.length - 1; i++) {
    const lo = table[i];
    const hi = table[i + 1];
    if (speedKph >= lo.kph && speedKph <= hi.kph) {
      if (speedKph === lo.kph) return { ssd: lo.ssd, clamped: false, interpolated: false };
      const t = (speedKph - lo.kph) / (hi.kph - lo.kph);
      const ssd = lo.ssd + t * (hi.ssd - lo.ssd);
      return { ssd: Math.round(ssd * 10) / 10, clamped: false, interpolated: true };
    }
  }
  return null; // unreachable
}

export interface XOption {
  value: number;
  label: string;
  note: string;
  warning?: boolean;
}

/** X distance (minor-arm setback) options. */
export const X_DISTANCE_OPTIONS: XOption[] = [
  {
    value: 2.4,
    label: "2.4 m",
    note: "Standard — MfS, car stopped near the give-way line",
  },
  {
    value: 2.0,
    label: "2.0 m",
    note: "Absolute minimum — lightly trafficked / low-speed situations only",
    warning: true,
  },
  {
    value: 4.5,
    label: "4.5 m",
    note: "Driver sees without encroaching — DMRB-style, busier junctions",
  },
];

/** Driver eye height, metres (MfS; permissible range 1.05–2.0 m). */
export const DRIVER_EYE_HEIGHT_M = 1.05;
export const DRIVER_EYE_HEIGHT_RANGE_M: [number, number] = [1.05, 2.0];

/**
 * Object height envelope: an obstruction matters if it intrudes into the
 * splay between these heights above the carriageway.
 */
export const OBJECT_HEIGHT_MIN_M = 0.6;
export const OBJECT_HEIGHT_MAX_M = 2.0;

export const STANDARD_LABELS: Record<StandardId, string> = {
  mfs: "MfS",
  cd109: "CD 109",
  manual: "Manual",
};

export const EXPORT_DISCLAIMER =
  "Desktop feasibility check only — not a substitute for a measured topographical survey and speed survey.";
