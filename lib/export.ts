"use client";

/**
 * PNG export: captures the map view with html2canvas, redraws the splay
 * geometry on top (vector overlays are not reliably captured by html2canvas,
 * so we hide them during capture and redraw from coordinates), then appends a
 * parameters summary block suitable for pasting into a technical note.
 */

import html2canvas from "html2canvas";
import type { LatLng, SplayParams, SplayPoints } from "./types";
import {
  EXPORT_DISCLAIMER,
  STANDARD_LABELS,
  kphToMph,
} from "./standards";

export interface ExportResults {
  yLeft: number | null;
  yRight: number | null;
  passLeft: boolean | null;
  passRight: boolean | null;
}

/**
 * Container-pixel position of a lat/lng for a top-down (tilt 0) map view.
 * Uses the Web Mercator world-coordinate maths from the Maps JS API docs.
 */
function toContainerPixel(
  map: google.maps.Map,
  latLng: LatLng
): { x: number; y: number } | null {
  const projection = map.getProjection();
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  if (!projection || !bounds || zoom == null) return null;

  const scale = Math.pow(2, zoom);
  const nw = projection.fromLatLngToPoint(
    new google.maps.LatLng(bounds.getNorthEast().lat(), bounds.getSouthWest().lng())
  );
  const world = projection.fromLatLngToPoint(new google.maps.LatLng(latLng));
  if (!nw || !world) return null;

  // Handle the antimeridian wrap conservatively (UK use — rarely relevant).
  let dx = world.x - nw.x;
  if (dx < 0) dx += 256;

  return { x: dx * scale, y: (world.y - nw.y) * scale };
}

function drawVertex(
  ctx: CanvasRenderingContext2D,
  p: { x: number; y: number },
  label: string,
  color: string
) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  ctx.font = "bold 13px system-ui, sans-serif";
  const w = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(15,23,42,0.85)";
  ctx.fillRect(p.x + 8, p.y - 18, w + 8, 18);
  ctx.fillStyle = "#f8fafc";
  ctx.fillText(label, p.x + 12, p.y - 5);
}

export async function exportSplayPng(opts: {
  mapDiv: HTMLElement;
  map: google.maps.Map;
  points: SplayPoints;
  params: SplayParams;
  results: ExportResults;
  siteName: string;
  /** Hide live overlays before capture, restore after. */
  setOverlaysVisible: (visible: boolean) => void;
}): Promise<void> {
  const { mapDiv, map, points, params, results, siteName, setOverlaysVisible } =
    opts;

  setOverlaysVisible(false);
  let capture: HTMLCanvasElement;
  try {
    capture = await html2canvas(mapDiv, {
      useCORS: true,
      allowTaint: false,
      logging: false,
      scale: 1,
      ignoreElements: (el) =>
        el.classList?.contains("splaycheck-no-export") ?? false,
    });
  } finally {
    setOverlaysVisible(true);
  }

  const mapW = capture.width;
  const mapH = capture.height;
  const blockH = 210;

  const out = document.createElement("canvas");
  out.width = mapW;
  out.height = mapH + blockH;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  ctx.drawImage(capture, 0, 0);

  // ---- Redraw the splay geometry ------------------------------------------
  const { mouth, origin, left, right } = points;
  const px = (p: LatLng | null) => (p ? toContainerPixel(map, p) : null);
  const pMouth = px(mouth);
  const pOrigin = px(origin);
  const pLeft = px(left);
  const pRight = px(right);

  const drawTriangle = (a: typeof pMouth, b: typeof pMouth, c: typeof pMouth) => {
    if (!a || !b || !c) return;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
    ctx.fillStyle = "rgba(239,68,68,0.22)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#dc2626";
    ctx.stroke();
  };
  drawTriangle(pOrigin, pMouth, pLeft);
  drawTriangle(pOrigin, pMouth, pRight);

  if (pOrigin) drawVertex(ctx, pOrigin, "A (origin)", "#f59e0b");
  if (pLeft) drawVertex(ctx, pLeft, "B (Y left)", results.passLeft ? "#22c55e" : "#ef4444");
  if (pRight) drawVertex(ctx, pRight, "C (Y right)", results.passRight ? "#22c55e" : "#ef4444");
  if (pMouth) drawVertex(ctx, pMouth, "Junction mouth", "#e2e8f0");

  // ---- Parameters summary block -------------------------------------------
  ctx.fillStyle = "#0f172a"; // slate-900
  ctx.fillRect(0, mapH, mapW, blockH);
  ctx.strokeStyle = "#334155";
  ctx.beginPath();
  ctx.moveTo(0, mapH + 0.5);
  ctx.lineTo(mapW, mapH + 0.5);
  ctx.stroke();

  const pad = 18;
  let y = mapH + 30;
  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 16px system-ui, sans-serif";
  ctx.fillText("SplayCheck — visibility splay assessment", pad, y);

  const dateStr = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillStyle = "#94a3b8";
  const dateW = ctx.measureText(dateStr).width;
  ctx.fillText(dateStr, mapW - pad - dateW, y);

  const speedMph = kphToMph(params.speedKph);
  const fmt = (v: number | null) =>
    v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)} m`;
  const passTxt = (p: boolean | null) =>
    p == null ? "—" : p ? "PASS" : "FAIL";

  const rows: [string, string][] = [
    ["Site", siteName || "Unnamed site"],
    [
      "Standard / speed",
      `${STANDARD_LABELS[params.standard]} · ${params.speedKph.toFixed(0)} kph (${speedMph.toFixed(0)} mph)${params.yOverridden ? " · Y overridden" : ""}`,
    ],
    ["X distance", `${params.xDistance.toFixed(1)} m`],
    ["Y required (SSD)", `${params.yRequired.toFixed(1)} m each side`],
    [
      "Y achieved — left (B)",
      `${fmt(results.yLeft)}  ${passTxt(results.passLeft)}`,
    ],
    [
      "Y achieved — right (C)",
      `${fmt(results.yRight)}  ${passTxt(results.passRight)}`,
    ],
  ];

  y += 12;
  const col2 = pad + 190;
  ctx.font = "13px system-ui, sans-serif";
  for (const [label, value] of rows) {
    y += 20;
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(label, pad, y);
    const isPass = value.includes("PASS");
    const isFail = value.includes("FAIL");
    ctx.fillStyle = isFail ? "#f87171" : isPass ? "#4ade80" : "#e2e8f0";
    ctx.fillText(value, col2, y);
  }

  y += 26;
  ctx.font = "italic 12px system-ui, sans-serif";
  ctx.fillStyle = "#fbbf24"; // amber-400
  ctx.fillText(EXPORT_DISCLAIMER, pad, y);

  // ---- Download ------------------------------------------------------------
  const blob = await new Promise<Blob | null>((resolve) =>
    out.toBlob(resolve, "image/png")
  );
  if (!blob) throw new Error("Failed to encode PNG");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (siteName || "assessment")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  a.href = url;
  a.download = `splaycheck-${safeName || "assessment"}-${new Date()
    .toISOString()
    .slice(0, 10)}.png`;
  a.click();
  URL.revokeObjectURL(url);
}
