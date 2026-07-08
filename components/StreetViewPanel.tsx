"use client";

/**
 * Street View sightline inspector. Positions a panorama at (or along) the
 * splay leg, faces it down the sightline toward the Y point, and overlays the
 * line as a receding trail of markers so the engineer can pan and judge
 * whether a hedge / fence / building cuts the view. Shows the camera-height
 * caveat and the imagery capture date with a staleness warning.
 */

import { useEffect, useRef, useState } from "react";
import type { LatLng } from "@/lib/types";
import { distanceM, headingDeg, offsetM, parseImageDate } from "@/lib/geo";

interface Props {
  /** Where the camera stands — Point A initially, or a point clicked along the line. */
  cameraLocation: LatLng;
  /** The active Y point (B or C) the sightline runs to. */
  target: LatLng;
  side: "left" | "right";
  requiredY: number;
  /** Driver eye height, metres (for the camera-height caveat). */
  eyeHeight: number;
  /** How far the camera currently is from Point A, along the line (m). */
  cameraOffsetM: number;
  onSwitchSide: () => void;
  onClose: () => void;
}

/** Search radius for the nearest panorama to the requested camera point. */
const SEARCH_RADIUS_M = 60;

export default function StreetViewPanel({
  cameraLocation,
  target,
  side,
  requiredY,
  eyeHeight,
  cameraOffsetM,
  onSwitchSide,
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panoRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const serviceRef = useRef<google.maps.StreetViewService | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "none">("loading");
  const [imageDate, setImageDate] = useState<string | null>(null);

  // Create the panorama once.
  useEffect(() => {
    if (!containerRef.current) return;
    const pano = new google.maps.StreetViewPanorama(containerRef.current, {
      visible: true,
      addressControl: false,
      fullscreenControl: false,
      motionTracking: false,
      motionTrackingControl: false,
      showRoadLabels: true,
      zoomControl: true,
      enableCloseButton: false,
    });
    panoRef.current = pano;
    serviceRef.current = new google.maps.StreetViewService();
    return () => {
      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = [];
      pano.setVisible(false);
      panoRef.current = null;
    };
  }, []);

  // Locate the nearest pano, aim it down the sightline, overlay the line.
  useEffect(() => {
    const pano = panoRef.current;
    const service = serviceRef.current;
    if (!pano || !service) return;
    let cancelled = false;
    setStatus("loading");

    service.getPanorama(
      {
        location: cameraLocation,
        radius: SEARCH_RADIUS_M,
        source: google.maps.StreetViewSource.OUTDOOR,
      },
      (data, svStatus) => {
        if (cancelled) return;
        if (
          svStatus !== google.maps.StreetViewStatus.OK ||
          !data?.location?.latLng ||
          !data.location.pano
        ) {
          setStatus("none");
          markersRef.current.forEach((m) => m.setMap(null));
          markersRef.current = [];
          return;
        }
        const panoPos = data.location.latLng.toJSON();
        pano.setPano(data.location.pano);
        pano.setPov({ heading: headingDeg(panoPos, target), pitch: 0 });
        pano.setZoom(0);
        setImageDate(data.imageDate ?? null);
        setStatus("ok");
        drawSightline(pano, panoPos, target);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [cameraLocation, target, requiredY]);

  function drawSightline(
    pano: google.maps.StreetViewPanorama,
    from: LatLng,
    to: LatLng
  ) {
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];
    const total = distanceM(from, to);
    const heading = headingDeg(from, to);
    const n = 12;
    for (let i = 1; i <= n; i++) {
      const d = (total * i) / n;
      const isEnd = i === n;
      const marker = new google.maps.Marker({
        position: offsetM(from, d, heading),
        map: pano,
        clickable: false,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: isEnd ? 7 : 4,
          fillColor: isEnd ? "#ef4444" : "#f59e0b",
          fillOpacity: isEnd ? 1 : 0.85,
          strokeColor: "#ffffff",
          strokeWeight: 1.5,
        },
        label: isEnd
          ? {
              text: `Y ${requiredY.toFixed(0)} m`,
              color: "#fecaca",
              fontSize: "12px",
              fontWeight: "700",
              className: "splay-handle-label",
            }
          : undefined,
        zIndex: isEnd ? 10 : 1,
      });
      markersRef.current.push(marker);
    }
  }

  const date = parseImageDate(imageDate);

  return (
    <div className="relative h-full w-full bg-slate-950">
      <div ref={containerRef} className="h-full w-full" />

      {/* Header controls */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
        <div className="pointer-events-auto flex overflow-hidden rounded-md border border-slate-600 bg-slate-900/90 shadow-lg">
          <span className="px-2.5 py-1.5 text-xs font-semibold text-slate-400">
            Sightline
          </span>
          <button
            onClick={onSwitchSide}
            className="border-l border-slate-600 px-3 py-1.5 text-sm font-medium text-sky-300 hover:bg-slate-700"
            title="Toggle which splay leg to inspect"
          >
            {side === "left" ? "◀ Left (A–B)" : "Right (A–C) ▶"}
          </button>
        </div>
        <button
          onClick={onClose}
          className="pointer-events-auto rounded-md border border-slate-600 bg-slate-900/90 px-3 py-1.5 text-sm font-medium text-slate-200 shadow-lg hover:bg-slate-700"
        >
          ✕ Close
        </button>
      </div>

      {/* Camera-height caveat */}
      <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center px-2.5">
        <div className="max-w-md rounded-md border border-amber-500/50 bg-amber-950/85 px-3 py-1.5 text-center text-xs leading-4 text-amber-200 shadow-lg">
          Street View camera height ≈ 2.5 m vs driver eye height{" "}
          {eyeHeight.toFixed(2)} m — obstructions may be worse at eye level.
        </div>
      </div>

      {/* Footer: capture date + guidance */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-2.5">
        <div className="pointer-events-none rounded-md border border-slate-600 bg-slate-900/90 px-2.5 py-1.5 text-[11px] leading-4 text-slate-300 shadow-lg">
          {cameraOffsetM < 1
            ? "Standing at Point A (driver position)"
            : `Standing ${cameraOffsetM.toFixed(0)} m along the line from A`}
          <span className="mx-1 text-slate-600">·</span>
          {date ? (
            <span className={date.stale ? "text-amber-300" : "text-slate-400"}>
              Imagery {date.label}
              {date.stale &&
                ` ⚠ ${date.ageYears.toFixed(0)} yrs old — vegetation may have grown`}
            </span>
          ) : status === "ok" ? (
            <span className="text-slate-500">Imagery date unavailable</span>
          ) : null}
        </div>
        <div className="pointer-events-none rounded-md border border-slate-700 bg-slate-900/80 px-2.5 py-1.5 text-[11px] text-slate-400 shadow-lg">
          Click the map along the sightline to move the camera
        </div>
      </div>

      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 text-sm text-slate-400">
          Finding Street View imagery…
        </div>
      )}
      {status === "none" && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/85 p-6 text-center text-sm text-slate-300">
          No Street View imagery within {SEARCH_RADIUS_M} m of this point. Try
          clicking closer to the road on the map.
        </div>
      )}
    </div>
  );
}
