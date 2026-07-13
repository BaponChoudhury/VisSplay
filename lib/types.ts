/** Plain serialisable lat/lng (google.maps.LatLngLiteral-compatible). */
export interface LatLng {
  lat: number;
  lng: number;
}

export type StandardId = "mfs" | "cd109" | "manual";

export interface SplayParams {
  standard: StandardId;
  /** Major-road speed in kph (design speed for CD 109, street speed for MfS). */
  speedKph: number;
  /** X distance (setback along minor arm) in metres. */
  xDistance: number;
  /**
   * Required Y distance in metres. Auto-filled from the SSD lookup for the
   * selected standard/speed, but always user-overridable (e.g. from a measured
   * 85th percentile speed survey).
   */
  yRequired: number;
  /** True when the engineer has typed a custom Y rather than using the table. */
  yOverridden: boolean;
  /** Driver eye height, metres (1.05–2.0). */
  eyeHeight: number;
  /** Lower object/obstruction height threshold, metres (0.26–2.0). */
  objectHeight: number;
}

/**
 * The splay geometry. `mouth` is the point where the minor-arm centreline
 * meets the nearer channel line / carriageway edge of the major road — the
 * apex of both sight triangles. `origin` is Point A (driver position, X metres
 * back). `left`/`right` are Points B and C on the nearer carriageway edge.
 */
export interface SplayPoints {
  mouth: LatLng | null;
  origin: LatLng | null;
  left: LatLng | null;
  right: LatLng | null;
}

/**
 * A proposed design layout (site plan / CAD sheet exported as an image)
 * superimposed on the map so splays can be drawn and checked against the new
 * design lines. Georeferencing is deliberately simple: geographic centre, the
 * real-world width the image spans, and a clockwise rotation.
 */
export interface DesignOverlaySettings {
  /** The plan image as a data URL (PNG/JPG uploaded by the engineer). */
  imageDataUrl: string;
  /** Original file name, for the panel and export summary. */
  imageName: string;
  /** Geographic position of the image centre. */
  center: LatLng;
  /** Real-world width the full image spans, metres. */
  widthM: number;
  /** Clockwise rotation from north-up, degrees. */
  rotationDeg: number;
  /** Overlay opacity, 0–1 (semi-transparent so the imagery reads through). */
  opacity: number;
  /** Toggle the overlay without losing its placement. */
  visible: boolean;
}

export interface SavedAssessment {
  id: string;
  name: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  params: SplayParams;
  points: SplayPoints;
  mapCenter: LatLng;
  mapZoom: number;
  /** Superimposed design layout, if one was placed (added later — optional). */
  designOverlay?: DesignOverlaySettings | null;
}
