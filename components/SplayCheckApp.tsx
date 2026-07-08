"use client";

/**
 * SplayCheck main app: Google Map, splay drawing state machine, measurement
 * tool, save/load and PNG export. All standards values come from
 * lib/standards.ts — nothing is hardcoded here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGoogleMaps } from "@/lib/useGoogleMaps";
import { distanceM, headingDeg, offsetM } from "@/lib/geo";
import { ssdForSpeed } from "@/lib/standards";
import type {
  LatLng,
  SavedAssessment,
  SplayParams,
  SplayPoints,
  StandardId,
} from "@/lib/types";
import { assessmentStore, newAssessmentId } from "@/lib/storage";
import { exportSplayPng } from "@/lib/export";
import ControlPanel from "./ControlPanel";

export type Step = "idle" | "mouth" | "origin" | "left" | "right" | "done";
export type Mode = "points" | "guided";
type VertexKey = "mouth" | "origin" | "left" | "right";

export interface SplayResults {
  yLeft: number | null;
  yRight: number | null;
  passLeft: boolean | null;
  passRight: boolean | null;
}

const DEFAULT_PARAMS: SplayParams = {
  standard: "mfs",
  speedKph: 48,
  xDistance: 2.4,
  yRequired: 43, // matches MfS table for 48 kph; kept in sync via ssdForSpeed
  yOverridden: false,
};

const EMPTY_POINTS: SplayPoints = {
  mouth: null,
  origin: null,
  left: null,
  right: null,
};

/** Rough UK centroid for the initial view. */
const UK_CENTER: LatLng = { lat: 52.8, lng: -1.9 };

/** Small tolerance so a handle snapped to exactly Y reads as a pass. */
const PASS_TOLERANCE_M = 0.05;

const VERTEX_COLORS: Record<VertexKey, string> = {
  mouth: "#e2e8f0", // slate-200
  origin: "#f59e0b", // amber-500
  left: "#f87171", // recoloured green on pass
  right: "#f87171",
};

const STEP_PROMPTS: Record<Step, string | null> = {
  idle: null,
  mouth:
    "Step 1 — click the JUNCTION MOUTH: where the minor-arm centreline meets the nearer edge (channel line) of the major road.",
  origin:
    "Step 2 — click along the minor arm to place POINT A (splay origin). With snap on, it locks exactly X metres back from the junction mouth in the direction of your cursor.",
  left: "Step 3 — click POINT B: the left-hand Y point on the nearer kerb / carriageway edge.",
  right:
    "Step 4 — click POINT C: the right-hand Y point on the nearer kerb / carriageway edge.",
  done: null,
};

export default function SplayCheckApp() {
  const mapsState = useGoogleMaps();

  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Partial<Record<VertexKey, google.maps.Marker>>>({});
  const polysRef = useRef<{
    left: google.maps.Polygon | null;
    right: google.maps.Polygon | null;
  }>({ left: null, right: null });
  const ghostMarkerRef = useRef<google.maps.Marker | null>(null);
  const ghostLineRef = useRef<google.maps.Polyline | null>(null);
  const measureMarkersRef = useRef<google.maps.Marker[]>([]);
  const measureLineRef = useRef<google.maps.Polyline | null>(null);
  const measurePtsRef = useRef<LatLng[]>([]);
  const searchInitRef = useRef(false);

  const [mapReady, setMapReady] = useState(false);
  const [mode, setMode] = useState<Mode>("points");
  const [step, setStep] = useState<Step>("idle");
  const [snapToX, setSnapToX] = useState(true);
  const [points, setPoints] = useState<SplayPoints>(EMPTY_POINTS);
  const [params, setParams] = useState<SplayParams>(DEFAULT_PARAMS);
  const [mapType, setMapType] = useState<"hybrid" | "roadmap">("hybrid");
  const [measuring, setMeasuring] = useState(false);
  const [measureDist, setMeasureDist] = useState<number | null>(null);
  const [siteName, setSiteName] = useState("");
  const [saved, setSaved] = useState<SavedAssessment[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Latest-state ref so persistent map listeners never see stale closures.
  const liveRef = useRef({ step, mode, snapToX, measuring, points, params });
  liveRef.current = { step, mode, snapToX, measuring, points, params };

  // ---------------------------------------------------------------- results
  const results: SplayResults = useMemo(() => {
    const empty: SplayResults = {
      yLeft: null,
      yRight: null,
      passLeft: null,
      passRight: null,
    };
    if (!mapReady || !points.mouth) return empty;
    const req = params.yRequired;
    const yLeft = points.left ? distanceM(points.mouth, points.left) : null;
    const yRight = points.right ? distanceM(points.mouth, points.right) : null;
    return {
      yLeft,
      yRight,
      passLeft: yLeft == null ? null : yLeft >= req - PASS_TOLERANCE_M,
      passRight: yRight == null ? null : yRight >= req - PASS_TOLERANCE_M,
    };
  }, [mapReady, points, params.yRequired]);

  // ------------------------------------------------------------ map clicks
  const handleMapClick = useCallback((pos: LatLng) => {
    const live = liveRef.current;

    if (live.measuring) {
      const pts = measurePtsRef.current;
      const next = pts.length >= 2 ? [pos] : [...pts, pos];
      measurePtsRef.current = next;
      drawMeasure(next);
      setMeasureDist(next.length === 2 ? distanceM(next[0], next[1]) : null);
      return;
    }

    switch (live.step) {
      case "mouth":
        setPoints({ ...EMPTY_POINTS, mouth: pos });
        setStep("origin");
        break;
      case "origin": {
        const mouth = live.points.mouth;
        if (!mouth) return;
        const origin = live.snapToX
          ? offsetM(mouth, live.params.xDistance, headingDeg(mouth, pos))
          : pos;
        clearGhost();
        if (live.mode === "guided") {
          // Auto-place both Y handles at the required distance, perpendicular
          // to the minor arm — the engineer then drags them along the road.
          const toMouth = headingDeg(origin, mouth);
          const y = live.params.yRequired;
          setPoints((prev) => ({
            ...prev,
            origin,
            left: offsetM(mouth, y, toMouth - 90),
            right: offsetM(mouth, y, toMouth + 90),
          }));
          setStep("done");
        } else {
          setPoints((prev) => ({ ...prev, origin }));
          setStep("left");
        }
        break;
      }
      case "left":
        setPoints((prev) => ({ ...prev, left: pos }));
        setStep("right");
        break;
      case "right":
        setPoints((prev) => ({ ...prev, right: pos }));
        setStep("done");
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMapMouseMove = useCallback((pos: LatLng) => {
    const live = liveRef.current;
    const map = mapRef.current;
    if (!map) return;
    if (live.step !== "origin" || !live.points.mouth) {
      clearGhost();
      return;
    }
    const mouth = live.points.mouth;
    const ghost = live.snapToX
      ? offsetM(mouth, live.params.xDistance, headingDeg(mouth, pos))
      : pos;

    if (!ghostMarkerRef.current) {
      ghostMarkerRef.current = new google.maps.Marker({
        map,
        clickable: false,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: "#f59e0b",
          fillOpacity: 0.5,
          strokeColor: "#fbbf24",
          strokeWeight: 1.5,
        },
      });
    }
    ghostMarkerRef.current.setPosition(ghost);

    if (!ghostLineRef.current) {
      ghostLineRef.current = new google.maps.Polyline({
        map,
        clickable: false,
        strokeOpacity: 0,
        icons: [
          {
            icon: {
              path: "M 0,-1 0,1",
              strokeOpacity: 0.9,
              strokeColor: "#fbbf24",
              scale: 2,
            },
            offset: "0",
            repeat: "10px",
          },
        ],
      });
    }
    ghostLineRef.current.setPath([mouth, ghost]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearGhost() {
    ghostMarkerRef.current?.setMap(null);
    ghostMarkerRef.current = null;
    ghostLineRef.current?.setMap(null);
    ghostLineRef.current = null;
  }

  function drawMeasure(pts: LatLng[]) {
    const map = mapRef.current;
    if (!map) return;
    measureMarkersRef.current.forEach((m) => m.setMap(null));
    measureMarkersRef.current = pts.map(
      (p) =>
        new google.maps.Marker({
          map,
          position: p,
          clickable: false,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 4.5,
            fillColor: "#38bdf8",
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 1.5,
          },
        })
    );
    if (!measureLineRef.current) {
      measureLineRef.current = new google.maps.Polyline({
        map,
        clickable: false,
        strokeColor: "#38bdf8",
        strokeWeight: 2.5,
      });
    }
    measureLineRef.current.setPath(pts);
    measureLineRef.current.setMap(pts.length >= 2 ? map : null);
    if (pts.length === 2) {
      const mid = google.maps.geometry.spherical.interpolate(
        new google.maps.LatLng(pts[0]),
        new google.maps.LatLng(pts[1]),
        0.5
      );
      const label = new google.maps.Marker({
        map,
        position: mid,
        clickable: false,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 0,
        },
        label: {
          text: `${distanceM(pts[0], pts[1]).toFixed(1)} m`,
          color: "#7dd3fc",
          fontSize: "12px",
          fontWeight: "600",
          className: "splay-handle-label",
        },
      });
      measureMarkersRef.current.push(label);
    }
  }

  function clearMeasure() {
    measurePtsRef.current = [];
    measureMarkersRef.current.forEach((m) => m.setMap(null));
    measureMarkersRef.current = [];
    measureLineRef.current?.setMap(null);
    measureLineRef.current = null;
    setMeasureDist(null);
  }

  // ---------------------------------------------------------- map creation
  useEffect(() => {
    if (mapsState.status !== "ready" || !mapDivRef.current || mapRef.current)
      return;
    const map = new google.maps.Map(mapDivRef.current, {
      center: UK_CENTER,
      zoom: 7,
      mapTypeId: "hybrid",
      tilt: 0,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      rotateControl: false,
      clickableIcons: false,
      gestureHandling: "greedy",
      draggableCursor: "crosshair",
      zoomControlOptions: {
        position: google.maps.ControlPosition.RIGHT_BOTTOM,
      },
    });
    map.addListener("click", (e: google.maps.MapMouseEvent) => {
      if (e.latLng) handleMapClick(e.latLng.toJSON());
    });
    map.addListener("mousemove", (e: google.maps.MapMouseEvent) => {
      if (e.latLng) handleMapMouseMove(e.latLng.toJSON());
    });
    // Keep the view top-down; 45° imagery breaks the export projection maths.
    map.addListener("tilt_changed", () => {
      if (map.getTilt() !== 0) map.setTilt(0);
    });
    mapRef.current = map;
    setMapReady(true);
  }, [mapsState.status, handleMapClick, handleMapMouseMove]);

  useEffect(() => {
    mapRef.current?.setMapTypeId(mapType);
  }, [mapType]);

  // ------------------------------------------------------- places search
  useEffect(() => {
    if (!mapReady || searchInitRef.current) return;
    const container = document.getElementById("splaycheck-search");
    if (!container) return;
    searchInitRef.current = true;

    const goTo = (
      location: google.maps.LatLng | null | undefined,
      viewport: google.maps.LatLngBounds | null | undefined
    ) => {
      const map = mapRef.current;
      if (!map) return;
      if (viewport) {
        map.fitBounds(viewport);
        if ((map.getZoom() ?? 0) > 19) map.setZoom(19);
      } else if (location) {
        map.setCenter(location);
        map.setZoom(18);
      }
    };

    const places = google.maps.places as unknown as Record<string, unknown>;
    const PacElement = places?.PlaceAutocompleteElement as
      | (new (opts?: object) => HTMLElement)
      | undefined;

    if (PacElement) {
      const el = new PacElement({ locationBias: UK_CENTER }) as HTMLElement & {
        addEventListener: HTMLElement["addEventListener"];
      };
      const onSelect = async (ev: Event) => {
        const anyEv = ev as unknown as {
          placePrediction?: { toPlace: () => google.maps.places.Place };
          place?: google.maps.places.Place;
        };
        try {
          const place = anyEv.placePrediction
            ? anyEv.placePrediction.toPlace()
            : anyEv.place;
          if (!place) return;
          await place.fetchFields({ fields: ["location", "viewport"] });
          goTo(place.location, place.viewport);
        } catch {
          /* selection failed — ignore */
        }
      };
      el.addEventListener("gmp-select", onSelect);
      el.addEventListener("gmp-placeselect", onSelect);
      container.appendChild(el);
    } else {
      // Fallback for keys that only have the legacy Places API enabled.
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Search address or postcode…";
      input.className =
        "w-full rounded-md border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none";
      const ac = new google.maps.places.Autocomplete(input, {
        fields: ["geometry"],
      });
      ac.addListener("place_changed", () => {
        const g = ac.getPlace()?.geometry;
        if (g) goTo(g.location, g.viewport);
      });
      container.appendChild(input);
    }
  }, [mapReady]);

  // ----------------------------------------------- splay overlays redraw
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const ensureMarker = (key: VertexKey): google.maps.Marker => {
      let m = markersRef.current[key];
      if (!m) {
        m = new google.maps.Marker({ map, draggable: true, cursor: "move" });
        m.addListener("drag", (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          const pos = e.latLng.toJSON();
          setPoints((prev) => ({ ...prev, [key]: pos }));
        });
        markersRef.current[key] = m;
      }
      return m;
    };

    const req = params.yRequired;
    (Object.keys(EMPTY_POINTS) as VertexKey[]).forEach((key) => {
      const pos = points[key];
      const existing = markersRef.current[key];
      if (!pos) {
        existing?.setMap(null);
        delete markersRef.current[key];
        return;
      }
      const m = ensureMarker(key);
      if (m.getMap() !== map) m.setMap(map);
      const cur = m.getPosition();
      if (!cur || cur.lat() !== pos.lat || cur.lng() !== pos.lng) {
        m.setPosition(pos);
      }

      let fill = VERTEX_COLORS[key];
      let labelText: string | null = null;
      let labelColor = "#e2e8f0";
      if ((key === "left" || key === "right") && points.mouth) {
        const d = distanceM(points.mouth, pos);
        const pass = d >= req - PASS_TOLERANCE_M;
        fill = pass ? "#22c55e" : "#ef4444";
        labelColor = pass ? "#4ade80" : "#f87171";
        labelText = `${key === "left" ? "B" : "C"} · ${d.toFixed(1)} m`;
      } else if (key === "origin" && points.mouth) {
        labelText = `A · X ${distanceM(points.mouth, pos).toFixed(1)} m`;
        labelColor = "#fbbf24";
      }
      m.setIcon({
        path: google.maps.SymbolPath.CIRCLE,
        scale: key === "mouth" ? 5.5 : 7,
        fillColor: fill,
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 2,
      });
      m.setLabel(
        labelText
          ? {
              text: labelText,
              color: labelColor,
              fontSize: "12px",
              fontWeight: "600",
              className: "splay-handle-label",
            }
          : null
      );
      m.setZIndex(key === "mouth" ? 10 : 20);
    });

    const ensurePoly = (side: "left" | "right"): google.maps.Polygon => {
      let p = polysRef.current[side];
      if (!p) {
        p = new google.maps.Polygon({
          map,
          fillColor: "#ef4444",
          fillOpacity: 0.18,
          strokeColor: "#dc2626",
          strokeWeight: 2,
          clickable: false,
          geodesic: true,
        });
        polysRef.current[side] = p;
      }
      return p;
    };

    (["left", "right"] as const).forEach((side) => {
      const tip = points[side];
      if (points.origin && points.mouth && tip) {
        const poly = ensurePoly(side);
        poly.setPath([points.origin, points.mouth, tip]);
        if (poly.getMap() !== map) poly.setMap(map);
      } else {
        polysRef.current[side]?.setMap(null);
        polysRef.current[side] = null;
      }
    });
  }, [mapReady, points, params.yRequired]);

  // ------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      )
        return;

      if (e.key === "Escape") {
        if (liveRef.current.measuring) {
          setMeasuring(false);
          clearMeasure();
        } else if (
          liveRef.current.step !== "idle" &&
          liveRef.current.step !== "done"
        ) {
          clearGhost();
          setPoints(EMPTY_POINTS);
          setStep("idle");
        }
      } else if (e.key === "Enter") {
        if (liveRef.current.measuring) {
          setMeasuring(false); // keep the measured line on screen
        } else if (
          liveRef.current.step !== "idle" &&
          liveRef.current.step !== "done" &&
          liveRef.current.points.mouth &&
          liveRef.current.points.origin
        ) {
          // Confirm early with whatever is placed so far.
          setStep("done");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ------------------------------------------------------------ actions
  const startDrawing = (m: Mode) => {
    clearGhost();
    setMode(m);
    setPoints(EMPTY_POINTS);
    setCurrentId(null);
    setStep("mouth");
    if (measuring) {
      setMeasuring(false);
      clearMeasure();
    }
  };

  const resetSplay = () => {
    clearGhost();
    setPoints(EMPTY_POINTS);
    setStep("idle");
    setCurrentId(null);
  };

  const toggleMeasure = () => {
    if (measuring) {
      setMeasuring(false);
      clearMeasure();
    } else {
      setMeasuring(true);
      clearMeasure();
    }
  };

  const updateParams = (patch: Partial<SplayParams>) => {
    setParams((prev) => {
      const next = { ...prev, ...patch };
      // Re-derive Y from the lookup table unless the engineer overrode it or
      // is in manual mode.
      if (!next.yOverridden && next.standard !== "manual") {
        const r = ssdForSpeed(next.standard, next.speedKph);
        if (r) next.yRequired = r.ssd;
      }
      return next;
    });
  };

  const refreshSaved = useCallback(async () => {
    setSaved(await assessmentStore.list());
  }, []);

  useEffect(() => {
    void refreshSaved();
  }, [refreshSaved]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  };

  const saveAssessment = async (asNew: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    const now = new Date().toISOString();
    const id = asNew || !currentId ? newAssessmentId() : currentId;
    const existing = currentId && !asNew ? saved.find((s) => s.id === id) : null;
    const assessment: SavedAssessment = {
      id,
      name: siteName.trim() || "Untitled assessment",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      params,
      points,
      mapCenter: map.getCenter()?.toJSON() ?? UK_CENTER,
      mapZoom: map.getZoom() ?? 17,
    };
    await assessmentStore.save(assessment);
    setCurrentId(id);
    await refreshSaved();
    flash(`Saved “${assessment.name}”`);
  };

  const loadAssessment = async (id: string) => {
    const a = await assessmentStore.get(id);
    const map = mapRef.current;
    if (!a || !map) return;
    clearGhost();
    if (measuring) {
      setMeasuring(false);
      clearMeasure();
    }
    setParams(a.params);
    setPoints(a.points);
    setSiteName(a.name);
    setCurrentId(a.id);
    const complete =
      a.points.mouth && a.points.origin && a.points.left && a.points.right;
    setStep(complete ? "done" : "idle");
    map.setCenter(a.mapCenter);
    map.setZoom(a.mapZoom);
  };

  const deleteAssessment = async (id: string) => {
    await assessmentStore.remove(id);
    if (currentId === id) setCurrentId(null);
    await refreshSaved();
  };

  const setOverlaysVisible = useCallback((visible: boolean) => {
    const map = visible ? mapRef.current : null;
    Object.values(markersRef.current).forEach((m) => m?.setMap(map));
    polysRef.current.left?.setMap(map);
    polysRef.current.right?.setMap(map);
    measureMarkersRef.current.forEach((m) => m.setMap(map));
    measureLineRef.current?.setMap(
      map && measurePtsRef.current.length >= 2 ? map : null
    );
    ghostMarkerRef.current?.setMap(map);
    ghostLineRef.current?.setMap(map);
  }, []);

  const doExport = async () => {
    const map = mapRef.current;
    const div = mapDivRef.current;
    if (!map || !div) return;
    setExporting(true);
    try {
      await exportSplayPng({
        mapDiv: div,
        map,
        points,
        params,
        results,
        siteName,
        setOverlaysVisible,
      });
    } catch (err) {
      flash(
        "Export failed (map imagery blocked canvas capture). Use a screenshot tool as a fallback."
      );
      console.error("SplayCheck export failed:", err);
    } finally {
      setExporting(false);
    }
  };

  // ------------------------------------------------------------- render
  if (mapsState.status === "missing-key") {
    return <MissingKeyScreen />;
  }

  const prompt = measuring
    ? measureDist != null
      ? `Measured: ${measureDist.toFixed(2)} m — click to start a new measurement, Esc to exit.`
      : "Measure — click two points on the map. Esc to exit."
    : STEP_PROMPTS[step];

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-slate-950">
      <ControlPanel
        open={panelOpen}
        onToggleOpen={() => setPanelOpen((v) => !v)}
        mapsStatus={mapsState.status}
        mode={mode}
        step={step}
        snapToX={snapToX}
        onSnapToX={setSnapToX}
        onStartDrawing={startDrawing}
        onReset={resetSplay}
        params={params}
        onUpdateParams={updateParams}
        results={results}
        measuring={measuring}
        measureDist={measureDist}
        onToggleMeasure={toggleMeasure}
        mapType={mapType}
        onMapType={setMapType}
        siteName={siteName}
        onSiteName={setSiteName}
        onSave={() => void saveAssessment(false)}
        onSaveAsNew={() => void saveAssessment(true)}
        canExport={
          !!(points.mouth && points.origin && points.left && points.right)
        }
        exporting={exporting}
        onExport={() => void doExport()}
        saved={saved}
        currentId={currentId}
        onLoad={(id) => void loadAssessment(id)}
        onDelete={(id) => void deleteAssessment(id)}
      />

      <div className="relative min-w-0 flex-1">
        <div ref={mapDivRef} className="h-full w-full" />

        {mapsState.status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 text-slate-400">
            Loading Google Maps…
          </div>
        )}
        {mapsState.status === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/90 p-8 text-center text-red-400">
            Failed to load Google Maps: {mapsState.message}. Check the API key
            in .env.local and that “Maps JavaScript API” is enabled.
          </div>
        )}

        {prompt && (
          <div className="splaycheck-no-export pointer-events-none absolute left-1/2 top-4 z-10 max-w-xl -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-900/95 px-4 py-2.5 text-sm text-slate-200 shadow-xl">
            {prompt}
            {!measuring && step !== "done" && step !== "idle" && (
              <span className="ml-2 text-xs text-slate-500">
                Esc cancels · Enter confirms
              </span>
            )}
          </div>
        )}

        {notice && (
          <div className="splaycheck-no-export absolute bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm text-slate-100 shadow-xl">
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}

function MissingKeyScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-slate-950 p-8">
      <div className="max-w-xl rounded-xl border border-slate-700 bg-slate-900 p-8 shadow-2xl">
        <h1 className="text-xl font-semibold text-slate-100">
          SplayCheck — API key needed
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          No Google Maps API key found. Create a file called{" "}
          <code className="rounded bg-slate-800 px-1.5 py-0.5 text-sky-300">
            .env.local
          </code>{" "}
          in the project root (copy{" "}
          <code className="rounded bg-slate-800 px-1.5 py-0.5 text-sky-300">
            .env.local.example
          </code>
          ) containing:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs text-emerald-300">
          NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your-key-here
        </pre>
        <p className="mt-4 text-sm leading-6 text-slate-300">
          In Google Cloud Console, enable on the key’s project:
        </p>
        <ul className="mt-2 list-disc pl-5 text-sm leading-6 text-slate-300">
          <li>Maps JavaScript API</li>
          <li>Places API (New) — for the address search box</li>
          <li>Map Tiles API — later, for Phase 3 (3D tiles)</li>
        </ul>
        <p className="mt-4 text-xs text-slate-500">
          Restart the dev server after creating .env.local.
        </p>
      </div>
    </div>
  );
}
