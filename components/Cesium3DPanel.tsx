"use client";

/**
 * Phase 3 — 3D photorealistic driver's-eye view (CesiumJS + Google
 * Photorealistic 3D Tiles).
 *
 * Puts the camera at the vehicle: Point A (the X setback), at the driver eye
 * height above the road surface. BOTH splay legs are drawn — the line of sight
 * to the left Y point (B) and to the right Y point (C) — each with a vertical
 * obstruction "curtain" from the object height up to 2.0 m. The driver looks
 * ahead toward the junction by default and can snap the view left / right to
 * inspect each sightline, or switch to an orbit view. If a line passes through
 * a hedge, fence or building, that sightline is obstructed.
 *
 * Raising the eye height (1.05–2.0 m) lifts the camera in place — it does not
 * move the car. Requires the Map Tiles API enabled on the Google key.
 *
 * NOTE: clash judgement is visual/manual in this phase. A future Phase 4 could
 * add automated line-of-sight testing against Environment Agency LiDAR DSM.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { LatLng } from "@/lib/types";
import { OBJECT_HEIGHT_MAX_M } from "@/lib/standards";

// Cesium is far too large to run through the Next/webpack bundler, so it is
// loaded at runtime from the prebuilt UMD script in /public/cesium and used via
// window.Cesium. Only its *types* are imported here (erased at compile time).
type Cesium = typeof import("cesium");
type Viewer = import("cesium").Viewer;
type Cartesian3 = import("cesium").Cartesian3;

declare global {
  interface Window {
    Cesium?: Cesium;
    CESIUM_BASE_URL?: string;
  }
}

/** Load the Cesium UMD script once and resolve the global. */
function loadCesium(): Promise<Cesium> {
  return new Promise((resolve, reject) => {
    if (window.Cesium) return resolve(window.Cesium);
    window.CESIUM_BASE_URL = "/cesium";
    const done = () =>
      window.Cesium
        ? resolve(window.Cesium)
        : reject(new Error("Cesium global not found after load"));
    const existing = document.getElementById(
      "cesium-script"
    ) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", done);
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load /cesium/Cesium.js"))
      );
      if (window.Cesium) resolve(window.Cesium);
      return;
    }
    const s = document.createElement("script");
    s.id = "cesium-script";
    s.src = "/cesium/Cesium.js";
    s.async = true;
    s.onload = done;
    s.onerror = () => reject(new Error("Failed to load /cesium/Cesium.js"));
    document.head.appendChild(s);
  });
}

// The camera view: an overhead orbit, or from the driver's seat looking left
// (toward B), straight ahead (toward the junction), or right (toward C).
type ViewMode = "orbit" | "seat-left" | "seat-ahead" | "seat-right";

/** Result of the automated line-of-sight test along one splay leg. */
type LegResult = {
  clear: boolean;
  /** Distance from Point A (m) where the surface most intrudes above the line. */
  worstDistM: number;
  /** How far the surface rises above the line of sight there (m); 0 if clear. */
  worstIntrusionM: number;
  /** True if the tile surface could not be sampled along the leg. */
  incomplete: boolean;
} | null;

/** Tolerance (m) — surface must rise this far above the line to count as a block. */
const INTRUSION_TOLERANCE_M = 0.1;

interface Props {
  apiKey: string;
  origin: LatLng;
  left: LatLng | null;
  right: LatLng | null;
  eyeHeight: number;
  objectHeight: number;
  requiredY: number;
  onClose: () => void;
}

export default function Cesium3DPanel({
  apiKey,
  origin,
  left,
  right,
  eyeHeight,
  objectHeight,
  requiredY,
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cesiumRef = useRef<Cesium | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  // Cached road-surface heights (m) at each point, keyed by "lat,lng".
  const groundRef = useRef<Map<string, number>>(new Map());

  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("orbit");
  const [checking, setChecking] = useState(false);
  const [checkLeft, setCheckLeft] = useState<LegResult>(null);
  const [checkRight, setCheckRight] = useState<LegResult>(null);

  const key = (p: LatLng) => `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;
  const groundAt = (p: LatLng) => groundRef.current.get(key(p)) ?? 0;
  const midpoint = (a: LatLng, b: LatLng): LatLng => ({
    lat: (a.lat + b.lat) / 2,
    lng: (a.lng + b.lng) / 2,
  });
  const resultFor = (side: "left" | "right") =>
    side === "left" ? checkLeft : checkRight;

  // ---- sample the road-surface height at the splay points -----------------
  // Returns true once the origin (driver) height is known, so the caller can
  // wait for the tiles to stream in before dropping the camera to eye level.
  const sampleGround = useCallback(async (): Promise<boolean> => {
    const Cesium = cesiumRef.current;
    const viewer = viewerRef.current;
    if (!Cesium || !viewer) return false;
    const scene = viewer.scene;
    const pts = [origin, left, right].filter(Boolean) as LatLng[];
    try {
      if (scene.sampleHeightSupported) {
        // Preferred on the 3D tiles: returns cartographics with height set.
        const cartos = pts.map((p) =>
          Cesium.Cartographic.fromDegrees(p.lng, p.lat)
        );
        const updated = await scene.sampleHeightMostDetailed(cartos);
        updated.forEach((c, i) => {
          if (c && Number.isFinite(c.height))
            groundRef.current.set(key(pts[i]), c.height);
        });
      } else {
        const cartesians = pts.map((p) =>
          Cesium.Cartesian3.fromDegrees(p.lng, p.lat, 0)
        );
        const clamped = await scene.clampToHeightMostDetailed(cartesians);
        clamped.forEach((c: Cartesian3 | undefined, i: number) => {
          if (c)
            groundRef.current.set(
              key(pts[i]),
              Cesium.Cartographic.fromCartesian(c).height
            );
        });
      }
    } catch {
      /* leave heights unset; caller retries */
    }
    return groundRef.current.has(key(origin));
  }, [origin, left, right]);

  /** Frame the whole splay from above so tiles start streaming immediately. */
  const frameArea = useCallback(() => {
    const Cesium = cesiumRef.current;
    const viewer = viewerRef.current;
    if (!Cesium || !viewer) return;
    const pts = [origin, left, right].filter(Boolean) as LatLng[];
    const cartesians = pts.map((p) =>
      Cesium.Cartesian3.fromDegrees(p.lng, p.lat, 0)
    );
    const sphere = Cesium.BoundingSphere.fromPoints(cartesians);
    viewer.camera.flyToBoundingSphere(sphere, {
      duration: 0,
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-45),
        Math.max(120, sphere.radius * 3)
      ),
    });
  }, [origin, left, right]);

  // ---- automated line-of-sight test along a leg ---------------------------
  // Samples the 3D-tile surface at ~1 m steps along A→Y and checks whether it
  // rises above the straight line from the driver eye (ground_A + eye height)
  // to the object at Y (ground_Y + object height). Reports the worst intrusion.
  const checkLeg = useCallback(
    async (pt: LatLng): Promise<LegResult> => {
      const Cesium = cesiumRef.current;
      const viewer = viewerRef.current;
      if (!Cesium || !viewer) return null;
      if (!groundRef.current.has(key(origin)) || !groundRef.current.has(key(pt)))
        return { clear: true, worstDistM: 0, worstIntrusionM: 0, incomplete: true };

      const gA = groundAt(origin);
      const gY = groundAt(pt);
      const eyeAbs = gA + eyeHeight;
      const targetAbs = gY + objectHeight;
      const totalM = Cesium.Cartesian3.distance(
        Cesium.Cartesian3.fromDegrees(origin.lng, origin.lat, 0),
        Cesium.Cartesian3.fromDegrees(pt.lng, pt.lat, 0)
      );
      const steps = Math.min(80, Math.max(12, Math.round(totalM)));
      const fracs: number[] = [];
      const cartos: import("cesium").Cartographic[] = [];
      for (let i = 1; i < steps; i++) {
        const f = i / steps;
        fracs.push(f);
        cartos.push(
          Cesium.Cartographic.fromDegrees(
            origin.lng + (pt.lng - origin.lng) * f,
            origin.lat + (pt.lat - origin.lat) * f
          )
        );
      }

      let sampled: (import("cesium").Cartographic | undefined)[] = [];
      try {
        if (viewer.scene.sampleHeightSupported) {
          sampled = await viewer.scene.sampleHeightMostDetailed(cartos);
        } else {
          const cs = await viewer.scene.clampToHeightMostDetailed(
            cartos.map((c) =>
              Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0)
            )
          );
          sampled = cs.map((c: Cartesian3 | undefined) =>
            c ? Cesium.Cartographic.fromCartesian(c) : undefined
          );
        }
      } catch {
        return { clear: true, worstDistM: 0, worstIntrusionM: 0, incomplete: true };
      }

      let worstIntr = -Infinity;
      let worstDist = 0;
      let missing = 0;
      sampled.forEach((c, i) => {
        if (!c || !Number.isFinite(c.height)) {
          missing++;
          return;
        }
        const f = fracs[i];
        const losH = eyeAbs + (targetAbs - eyeAbs) * f;
        const intr = c.height - losH;
        if (intr > worstIntr) {
          worstIntr = intr;
          worstDist = f * totalM;
        }
      });
      if (worstIntr === -Infinity)
        return { clear: true, worstDistM: 0, worstIntrusionM: 0, incomplete: true };
      return {
        clear: worstIntr <= INTRUSION_TOLERANCE_M,
        worstDistM: worstDist,
        worstIntrusionM: Math.max(0, worstIntr),
        incomplete: missing > sampled.length * 0.3,
      };
    },
    [origin, left, right, eyeHeight, objectHeight]
  );

  const runSightlineCheck = useCallback(async () => {
    setChecking(true);
    const l = left ? await checkLeg(left) : null;
    const r = right ? await checkLeg(right) : null;
    setCheckLeft(l);
    setCheckRight(r);
    setChecking(false);
  }, [left, right, checkLeg]);

  // ---- draw both sightlines + envelopes and place the camera --------------
  const redraw = useCallback(() => {
    const Cesium = cesiumRef.current;
    const viewer = viewerRef.current;
    if (!Cesium || !viewer) return;

    viewer.entities.removeAll();

    const red = Cesium.Color.fromCssColorString("#ef4444");
    const amber = Cesium.Color.fromCssColorString("#f59e0b");
    const sky = Cesium.Color.fromCssColorString("#38bdf8");

    const gA = groundAt(origin);
    const eye = Cesium.Cartesian3.fromDegrees(
      origin.lng,
      origin.lat,
      gA + eyeHeight
    );

    const green = Cesium.Color.fromCssColorString("#22c55e");
    const totalTo = (pt: LatLng) =>
      Cesium.Cartesian3.distance(
        Cesium.Cartesian3.fromDegrees(origin.lng, origin.lat, 0),
        Cesium.Cartesian3.fromDegrees(pt.lng, pt.lat, 0)
      );

    const drawLeg = (pt: LatLng, label: string, side: "left" | "right") => {
      const gY = groundAt(pt);
      const eyeAbs = gA + eyeHeight;
      const targetAbs = gY + objectHeight;
      // The line of sight runs from the driver eye to the object at Y (at the
      // object height) — this is exactly the line the check tests.
      const yTarget = Cesium.Cartesian3.fromDegrees(
        pt.lng,
        pt.lat,
        targetAbs
      );
      const res = resultFor(side);
      const clear = !res || res.clear;
      const losColor = clear ? green : red;

      viewer.entities.add({
        polyline: { positions: [eye, yTarget], width: 5, material: losColor },
      });
      // Obstruction envelope curtain: object height → 2.0 m along the leg.
      viewer.entities.add({
        wall: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([
            origin.lng,
            origin.lat,
            gA + objectHeight,
            pt.lng,
            pt.lat,
            gY + objectHeight,
          ]),
          maximumHeights: [gA + OBJECT_HEIGHT_MAX_M, gY + OBJECT_HEIGHT_MAX_M],
          minimumHeights: [gA + objectHeight, gY + objectHeight],
          material: losColor.withAlpha(0.12),
          outline: true,
          outlineColor: losColor.withAlpha(0.6),
        },
      });
      // Ground guide line.
      viewer.entities.add({
        polyline: {
          positions: [
            Cesium.Cartesian3.fromDegrees(origin.lng, origin.lat, gA),
            Cesium.Cartesian3.fromDegrees(pt.lng, pt.lat, gY),
          ],
          width: 2,
          material: sky.withAlpha(0.7),
        },
      });
      // Y marker.
      viewer.entities.add({
        position: yTarget,
        point: {
          pixelSize: 11,
          color: losColor,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
        },
        label: {
          text: `Y ${label} ${requiredY.toFixed(0)} m`,
          font: "700 13px system-ui, sans-serif",
          fillColor: Cesium.Color.fromCssColorString("#e2e8f0"),
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString("#0f172acc"),
          pixelOffset: new Cesium.Cartesian2(0, -22),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      // Obstruction marker at the worst intrusion point.
      if (res && !res.clear && res.worstIntrusionM > 0) {
        const total = totalTo(pt);
        const f = total > 0 ? res.worstDistM / total : 0;
        const losH = eyeAbs + (targetAbs - eyeAbs) * f;
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(
            origin.lng + (pt.lng - origin.lng) * f,
            origin.lat + (pt.lat - origin.lat) * f,
            losH
          ),
          point: {
            pixelSize: 14,
            color: red,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
          },
          label: {
            text: `⚠ blocked +${res.worstIntrusionM.toFixed(1)} m @ ${res.worstDistM.toFixed(0)} m`,
            font: "700 12px system-ui, sans-serif",
            fillColor: Cesium.Color.fromCssColorString("#fecaca"),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString("#7f1d1dcc"),
            pixelOffset: new Cesium.Cartesian2(0, 18),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    };

    if (left) drawLeg(left, "left (B)", "left");
    if (right) drawLeg(right, "right (C)", "right");

    // Driver eye marker (the vehicle).
    viewer.entities.add({
      position: eye,
      point: {
        pixelSize: 13,
        color: amber,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
      },
      label: {
        text: `Driver eye ${eyeHeight.toFixed(2)} m`,
        font: "600 13px system-ui, sans-serif",
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#0f172acc"),
        pixelOffset: new Cesium.Cartesian2(0, -24),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    placeCamera(Cesium, viewer, eye, gA);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    origin,
    left,
    right,
    eyeHeight,
    objectHeight,
    requiredY,
    view,
    checkLeft,
    checkRight,
  ]);

  function placeCamera(
    Cesium: Cesium,
    viewer: Viewer,
    eye: Cartesian3,
    gA: number
  ) {
    if (view !== "orbit") {
      // Driver's seat. Only drop to eye level once we know the road-surface
      // height; otherwise the camera would sit at the wrong altitude. Fall back
      // to the overview until the tiles have streamed in.
      if (!groundRef.current.has(key(origin))) {
        frameArea();
        return;
      }
      // What the driver looks at: the left leg (B), the right leg (C), or —
      // ahead — the mid-point between the two Y points (toward the junction).
      let look: LatLng | null = null;
      if (view === "seat-left") look = left;
      else if (view === "seat-right") look = right;
      else look = left && right ? midpoint(left, right) : left ?? right;
      if (!look) return;
      const gL = groundRef.current.get(key(look)) ?? gA;
      const target = Cesium.Cartesian3.fromDegrees(
        look.lng,
        look.lat,
        gL + eyeHeight
      );
      const dir = Cesium.Cartesian3.subtract(
        target,
        eye,
        new Cesium.Cartesian3()
      );
      Cesium.Cartesian3.normalize(dir, dir);
      const up = Cesium.Cartesian3.normalize(eye, new Cesium.Cartesian3());
      viewer.camera.setView({
        destination: eye,
        orientation: { direction: dir, up },
      });
    } else {
      // Orbit: frame the whole splay from above and behind Point A.
      const pts = [origin, left, right].filter(Boolean) as LatLng[];
      const midLng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
      const midLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
      const spread = Math.max(
        30,
        ...pts.map(
          (p) =>
            Cesium.Cartesian3.distance(
              Cesium.Cartesian3.fromDegrees(midLng, midLat, 0),
              Cesium.Cartesian3.fromDegrees(p.lng, p.lat, 0)
            ) || 0
        )
      );
      const center = Cesium.Cartesian3.fromDegrees(midLng, midLat, gA);
      viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(center, spread),
        {
          duration: 0.8,
          offset: new Cesium.HeadingPitchRange(
            0,
            Cesium.Math.toRadians(-40),
            spread * 3.2
          ),
        }
      );
    }
  }

  // ---- create the viewer + tileset once -----------------------------------
  useEffect(() => {
    let destroyed = false;
    (async () => {
      if (!containerRef.current) return;
      if (!document.getElementById("cesium-widgets-css")) {
        const link = document.createElement("link");
        link.id = "cesium-widgets-css";
        link.rel = "stylesheet";
        link.href = "/cesium/Widgets/widgets.css";
        document.head.appendChild(link);
      }

      let Cesium: Cesium;
      try {
        Cesium = await loadCesium();
      } catch (e) {
        if (!destroyed) {
          setStatus("error");
          setError(e instanceof Error ? e.message : String(e));
        }
        return;
      }
      if (destroyed || !containerRef.current) return;
      cesiumRef.current = Cesium;
      Cesium.GoogleMaps.defaultApiKey = apiKey;

      const viewer = new Cesium.Viewer(containerRef.current, {
        globe: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        creditContainer: document.createElement("div"),
      });
      if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;
      viewerRef.current = viewer;

      try {
        const tileset = await Cesium.createGooglePhotorealistic3DTileset();
        if (destroyed) return;
        viewer.scene.primitives.add(tileset);

        // Show the junction from above straight away so the user sees the area
        // while the detailed tiles stream in.
        frameArea();

        // The tile-surface height sampling only works once the tiles at the
        // point have loaded, which can take a few seconds. Retry until the
        // driver's ground height is known (or we give up and use the estimate).
        let gotGround = false;
        for (let attempt = 0; attempt < 8 && !destroyed; attempt++) {
          gotGround = await sampleGround();
          if (gotGround) break;
          await new Promise((r) => setTimeout(r, 900));
        }
        if (destroyed) return;
        setStatus("ready");
        redraw();
        // Run the automated line-of-sight test against the tile surface.
        void runSightlineCheck();
      } catch (e) {
        if (destroyed) return;
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      destroyed = true;
      const v = viewerRef.current;
      if (v && !v.isDestroyed()) v.destroy();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // Re-sample ground, redraw and re-run the check when the geometry changes.
  useEffect(() => {
    if (status !== "ready") return;
    let cancelled = false;
    (async () => {
      await sampleGround();
      if (cancelled) return;
      redraw();
      await runSightlineCheck();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    status,
    origin.lat,
    origin.lng,
    left?.lat,
    left?.lng,
    right?.lat,
    right?.lng,
  ]);

  // Eye/object height change the line of sight — redraw and re-run the check.
  useEffect(() => {
    if (status !== "ready") return;
    redraw();
    void runSightlineCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eyeHeight, objectHeight]);

  // View / required-Y only affect the camera or labels — just redraw.
  useEffect(() => {
    if (status === "ready") redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, requiredY]);

  const hasBoth = !!(left && right);

  return (
    <div className="relative h-full w-full bg-slate-950">
      <div ref={containerRef} className="h-full w-full" />

      {/* Header controls */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-slate-600 bg-slate-900/90 shadow-lg">
            <button
              onClick={() => setView("orbit")}
              className={`px-3 py-1.5 text-sm font-medium ${
                view === "orbit"
                  ? "bg-sky-600 text-white"
                  : "text-slate-300 hover:bg-slate-700"
              }`}
            >
              🛰 Orbit
            </button>
          </div>
          <div className="flex overflow-hidden rounded-md border border-slate-600 bg-slate-900/90 shadow-lg">
            <span className="px-2.5 py-1.5 text-xs font-semibold text-slate-400">
              Driver’s seat
            </span>
            {left && (
              <ViewBtn
                active={view === "seat-left"}
                onClick={() => setView("seat-left")}
              >
                ◀ Left
              </ViewBtn>
            )}
            {hasBoth && (
              <ViewBtn
                active={view === "seat-ahead"}
                onClick={() => setView("seat-ahead")}
              >
                Ahead
              </ViewBtn>
            )}
            {right && (
              <ViewBtn
                active={view === "seat-right"}
                onClick={() => setView("seat-right")}
              >
                Right ▶
              </ViewBtn>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="pointer-events-auto rounded-md border border-slate-600 bg-slate-900/90 px-3 py-1.5 text-sm font-medium text-slate-200 shadow-lg hover:bg-slate-700"
        >
          ✕ Close
        </button>
      </div>

      {/* Verdict panel */}
      {status === "ready" && (
        <div className="pointer-events-none absolute left-2.5 top-16 w-60 rounded-lg border border-slate-600 bg-slate-900/90 p-3 text-xs shadow-xl">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-semibold uppercase tracking-wider text-slate-400">
              Sightline check
            </span>
            {checking && <span className="text-slate-500">checking…</span>}
          </div>
          <VerdictRow label="Left (A–B)" res={checkLeft} present={!!left} />
          <VerdictRow label="Right (A–C)" res={checkRight} present={!!right} />
          <p className="mt-2 leading-4 text-slate-500">
            Eye {eyeHeight.toFixed(2)} m → object {objectHeight.toFixed(2)} m.
            Tests the 3D-tile surface along each leg. Verify on site — tiles
            include trees/parked cars and can be noisy.
          </p>
        </div>
      )}

      {status === "loading" && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
          <div className="rounded-md bg-slate-950/80 px-4 py-2 text-center text-sm text-slate-300">
            Loading Google 3D tiles and finding the road surface…
            <br />
            <span className="text-xs text-slate-500">
              a few seconds — the camera drops to eye level once ready
            </span>
          </div>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/90 p-6 text-center text-sm text-slate-300">
          <div>
            <p className="font-semibold text-red-400">
              Could not load 3D tiles.
            </p>
            <p className="mt-2 text-slate-300">
              Enable the <strong>Map Tiles API</strong> on this key’s project in
              Google Cloud Console, then reopen.
            </p>
            {error && (
              <p className="mt-2 break-words text-xs text-slate-500">{error}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ViewBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`border-l border-slate-600 px-2.5 py-1.5 text-sm font-medium ${
        active ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

function VerdictRow({
  label,
  res,
  present,
}: {
  label: string;
  res: LegResult;
  present: boolean;
}) {
  if (!present) return null;
  let badge: { text: string; cls: string };
  let detail: string | null = null;
  if (res == null) {
    badge = { text: "…", cls: "bg-slate-700 text-slate-300" };
  } else if (res.incomplete) {
    badge = { text: "NO DATA", cls: "bg-slate-600 text-slate-200" };
    detail = "tiles not fully loaded here";
  } else if (res.clear) {
    badge = { text: "CLEAR", cls: "bg-green-500/25 text-green-300" };
  } else {
    badge = { text: "OBSTRUCTED", cls: "bg-red-500/25 text-red-300" };
    detail = `rises ${res.worstIntrusionM.toFixed(1)} m above the line at ${res.worstDistM.toFixed(0)} m`;
  }
  return (
    <div className="mb-1.5">
      <div className="flex items-center justify-between">
        <span className="text-slate-300">{label}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${badge.cls}`}
        >
          {badge.text}
        </span>
      </div>
      {detail && <div className="mt-0.5 text-[10px] text-slate-500">{detail}</div>}
    </div>
  );
}
