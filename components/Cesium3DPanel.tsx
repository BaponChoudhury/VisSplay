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

import { useCallback, useEffect, useRef, useState } from "react";
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

type Preset = "driver" | "orbit";
type LookDir = "ahead" | "left" | "right";

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
  const [preset, setPreset] = useState<Preset>("driver");
  const [lookDir, setLookDir] = useState<LookDir>("ahead");

  const key = (p: LatLng) => `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;
  const groundAt = (p: LatLng) => groundRef.current.get(key(p)) ?? 0;
  const midpoint = (a: LatLng, b: LatLng): LatLng => ({
    lat: (a.lat + b.lat) / 2,
    lng: (a.lng + b.lng) / 2,
  });

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

    const drawLeg = (pt: LatLng, label: string) => {
      const gY = groundAt(pt);
      const yEye = Cesium.Cartesian3.fromDegrees(
        pt.lng,
        pt.lat,
        gY + eyeHeight
      );
      // Line of sight at eye level.
      viewer.entities.add({
        polyline: { positions: [eye, yEye], width: 4, material: red },
      });
      // Obstruction curtain: object height → 2.0 m along the leg.
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
          material: red.withAlpha(0.16),
          outline: true,
          outlineColor: red.withAlpha(0.7),
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
          material: sky.withAlpha(0.8),
        },
      });
      // Y marker.
      viewer.entities.add({
        position: yEye,
        point: {
          pixelSize: 12,
          color: red,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
        },
        label: {
          text: `Y ${label} ${requiredY.toFixed(0)} m`,
          font: "700 13px system-ui, sans-serif",
          fillColor: Cesium.Color.fromCssColorString("#fecaca"),
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString("#0f172acc"),
          pixelOffset: new Cesium.Cartesian2(0, -22),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    };

    if (left) drawLeg(left, "left (B)");
    if (right) drawLeg(right, "right (C)");

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
  }, [origin, left, right, eyeHeight, objectHeight, requiredY, preset, lookDir]);

  function placeCamera(
    Cesium: Cesium,
    viewer: Viewer,
    eye: Cartesian3,
    gA: number
  ) {
    if (preset === "driver") {
      // Only drop to the driver's eye once we actually know the road-surface
      // height; otherwise the camera would sit at the wrong altitude. Fall back
      // to the overview until the tiles have streamed in.
      if (!groundRef.current.has(key(origin))) {
        frameArea();
        return;
      }
      // Choose what the driver looks at: the chosen leg, or (ahead) the
      // mid-point between the two Y points — i.e. toward the junction.
      let look: LatLng | null = null;
      if (lookDir === "left") look = left;
      else if (lookDir === "right") look = right;
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
        redraw(); // drops the camera to the driver's eye
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

  // Re-sample ground + redraw when the geometry changes.
  useEffect(() => {
    if (status !== "ready") return;
    let cancelled = false;
    (async () => {
      await sampleGround();
      if (!cancelled) redraw();
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

  // Redraw (no re-sample) when eye height, object height, preset or look changes.
  useEffect(() => {
    if (status === "ready") redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eyeHeight, objectHeight, preset, lookDir, requiredY]);

  const hasBoth = !!(left && right);

  return (
    <div className="relative h-full w-full bg-slate-950">
      <div ref={containerRef} className="h-full w-full" />

      {/* Header controls */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
        <div className="pointer-events-auto flex flex-wrap gap-2">
          <div className="flex overflow-hidden rounded-md border border-slate-600 bg-slate-900/90 shadow-lg">
            <button
              onClick={() => setPreset("driver")}
              className={`px-3 py-1.5 text-sm font-medium ${
                preset === "driver"
                  ? "bg-sky-600 text-white"
                  : "text-slate-300 hover:bg-slate-700"
              }`}
            >
              Driver eye
            </button>
            <button
              onClick={() => setPreset("orbit")}
              className={`border-l border-slate-600 px-3 py-1.5 text-sm font-medium ${
                preset === "orbit"
                  ? "bg-sky-600 text-white"
                  : "text-slate-300 hover:bg-slate-700"
              }`}
            >
              Orbit
            </button>
          </div>
          {preset === "driver" && (
            <div className="flex overflow-hidden rounded-md border border-slate-600 bg-slate-900/90 shadow-lg">
              <span className="px-2.5 py-1.5 text-xs font-semibold text-slate-400">
                Look
              </span>
              {left && (
                <button
                  onClick={() => setLookDir("left")}
                  className={`border-l border-slate-600 px-2.5 py-1.5 text-sm font-medium ${
                    lookDir === "left"
                      ? "bg-sky-600 text-white"
                      : "text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  ◀ Left
                </button>
              )}
              {hasBoth && (
                <button
                  onClick={() => setLookDir("ahead")}
                  className={`border-l border-slate-600 px-2.5 py-1.5 text-sm font-medium ${
                    lookDir === "ahead"
                      ? "bg-sky-600 text-white"
                      : "text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  Ahead
                </button>
              )}
              {right && (
                <button
                  onClick={() => setLookDir("right")}
                  className={`border-l border-slate-600 px-2.5 py-1.5 text-sm font-medium ${
                    lookDir === "right"
                      ? "bg-sky-600 text-white"
                      : "text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  Right ▶
                </button>
              )}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="pointer-events-auto rounded-md border border-slate-600 bg-slate-900/90 px-3 py-1.5 text-sm font-medium text-slate-200 shadow-lg hover:bg-slate-700"
        >
          ✕ Close
        </button>
      </div>

      {/* Caption */}
      {status === "ready" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2.5">
          <div className="max-w-lg rounded-md border border-slate-600 bg-slate-900/90 px-3 py-1.5 text-center text-[11px] leading-4 text-slate-300 shadow-lg">
            From the driver eye at {eyeHeight.toFixed(2)} m. Both sightlines are
            drawn (red line) with the {objectHeight.toFixed(2)}–
            {OBJECT_HEIGHT_MAX_M.toFixed(1)} m obstruction curtain. If a line
            passes through a hedge, fence or building, that side is obstructed.
            Use Look ◀ ▶ or drag to check each side.
          </div>
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
