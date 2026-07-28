"use client";

/**
 * Ground levels & ponding from Environment Agency LiDAR (England).
 *
 * Data: the EA "LIDAR Composite DTM" open dataset (bare-earth terrain,
 * ±5–15 cm vertical). The EA endpoints send no CORS headers, so the raster is
 * fetched through this app's own /api/lidar route (server-side), which also
 * holds the endpoint discovery and fallbacks.
 *
 * Pipeline: /api/lidar (GeoTIFF) → geotiff.js → elevation grid → analysis
 * (min/max, contours by marching squares, ponding by priority-flood
 * depression filling) → a north-up PNG data URL overlaid on the map exactly
 * like the design-layout overlay.
 *
 * Open data (OGL), no API key. England coverage only.
 */

import type { LatLng } from "./types";

/** Longest side of the selected area, metres (keeps requests + analysis fast). */
export const LEVELS_MAX_SIDE_M = 500;
/** Shortest usable side, metres. */
export const LEVELS_MIN_SIDE_M = 15;

export interface DtmGrid {
  /** Elevations (mAOD), row-major from the NORTH-WEST corner. NaN = no data. */
  z: Float32Array;
  w: number;
  h: number;
  /** True ground size of one cell, metres. */
  cellM: number;
  /** Geographic bounds of the grid. */
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface LevelsAnalysis {
  grid: DtmGrid;
  minZ: number;
  maxZ: number;
  minPt: LatLng;
  maxPt: LatLng;
  /** Ponding depth per cell (m); 0 where water drains. */
  depth: Float32Array;
  maxDepth: number;
  /** Location of the deepest ponding, null if the area drains everywhere. */
  maxDepthPt: LatLng | null;
  /** Fraction of valid cells with ponding deeper than 2 cm. */
  pondFraction: number;
  /** Name of the EA service the data came from (for attribution). */
  sourceName: string;
}

// ---------------------------------------------------------------- helpers

const R = 6378137;
const mercX = (lng: number) => (R * lng * Math.PI) / 180;
const mercY = (lat: number) =>
  R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercX = (x: number) => (x / R) * (180 / Math.PI);
const invMercY = (y: number) =>
  (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);

// ------------------------------------------------------------- DTM fetch

/** True ground metres per Web-Mercator metre at this latitude. */
const groundScale = (lat: number) => Math.cos((lat * Math.PI) / 180);

/**
 * Fetch the terrain grid for a box.
 *
 * The EA endpoints send no CORS headers, so the browser is not allowed to
 * call them directly (it fails before the request is even sent). Everything
 * upstream therefore goes through this app's own /api/lidar route, which runs
 * server-side where the same-origin policy does not apply.
 */
export async function fetchDtmGrid(
  a: LatLng,
  b: LatLng
): Promise<{ grid: DtmGrid; sourceName: string }> {
  const south = Math.min(a.lat, b.lat);
  const north = Math.max(a.lat, b.lat);
  const west = Math.min(a.lng, b.lng);
  const east = Math.max(a.lng, b.lng);

  const x0 = mercX(west);
  const x1 = mercX(east);
  const y0 = mercY(south);
  const y1 = mercY(north);
  const k = groundScale((south + north) / 2); // merc -> true metres

  // Aim for roughly one pixel per metre of real ground.
  const cellMerc = 1 / k;
  const px = Math.max(8, Math.min(1600, Math.round((x1 - x0) / cellMerc)));
  const py = Math.max(8, Math.min(1600, Math.round((y1 - y0) / cellMerc)));

  const q = new URLSearchParams({
    s: String(south),
    w: String(west),
    n: String(north),
    e: String(east),
    px: String(px),
    py: String(py),
  });

  const res = await fetch(`/api/lidar?${q.toString()}`);
  if (!res.ok) {
    let msg = `Levels service returned ${res.status}.`;
    try {
      const j = (await res.json()) as {
        error?: string;
        attempts?: { label: string; detail: string }[];
      };
      const tried = (j.attempts ?? [])
        .map((t) => `${t.label}: ${t.detail}`)
        .join(" | ");
      msg = [j.error ?? msg, tried && `Tried - ${tried}`]
        .filter(Boolean)
        .join(" ");
    } catch {
      /* keep the status-code message */
    }
    throw new Error(msg);
  }

  const sourceName = res.headers.get("X-Lidar-Source") ?? "EA LiDAR";
  const buf = await res.arrayBuffer();

  const { fromArrayBuffer } = await import("geotiff");
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const rasters = (await img.readRasters()) as unknown as ArrayLike<number>[];
  const band = rasters[0];
  const gw = img.getWidth();
  const gh = img.getHeight();

  const z = new Float32Array(gw * gh);
  let valid = 0;
  for (let i = 0; i < gw * gh; i++) {
    const v = band[i];
    // EA nodata is a large negative sentinel (-9999 / -3.4e38) or NaN.
    if (v == null || !Number.isFinite(v) || v < -1000 || v > 5000) {
      z[i] = NaN;
    } else {
      z[i] = v;
      valid++;
    }
  }
  if (valid < gw * gh * 0.05) {
    throw new Error(
      "No LiDAR data here - EA coverage is England only (and has some gaps)."
    );
  }

  const grid: DtmGrid = {
    z,
    w: gw,
    h: gh,
    cellM: ((x1 - x0) / gw) * k,
    south,
    west,
    north,
    east,
  };
  return { grid, sourceName };
}

// ------------------------------------------------------------- analysis

const cellLatLng = (g: DtmGrid, ix: number, iy: number): LatLng => ({
  // Row 0 is the north edge. Convert via Mercator so rows line up with pixels.
  lat: invMercY(
    mercY(g.north) - ((iy + 0.5) / g.h) * (mercY(g.north) - mercY(g.south))
  ),
  lng: invMercX(
    mercX(g.west) + ((ix + 0.5) / g.w) * (mercX(g.east) - mercX(g.west))
  ),
});

/**
 * Blank out every cell outside a drawn polygon (set to no-data).
 *
 * Upstream can only serve rectangles, so an irregular area is fetched as its
 * bounding box and masked here. This is what makes a drawn boundary
 * meaningful for ponding: no-data cells drain, so the polygon edge becomes
 * the line water spills over — trace a site boundary and the result answers
 * "does it pond *within this site*".
 */
export function maskGridToPolygon(grid: DtmGrid, poly: LatLng[]): void {
  if (poly.length < 3) return;
  const px = poly.map((p) => mercX(p.lng));
  const py = poly.map((p) => mercY(p.lat));
  const x0 = mercX(grid.west);
  const x1 = mercX(grid.east);
  const y0 = mercY(grid.south);
  const y1 = mercY(grid.north);
  const n = poly.length;

  // Ray casting in Mercator space — the polygon and the grid share that
  // projection, so a planar test is exact here.
  const inside = (x: number, y: number): boolean => {
    let hit = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = py[i];
      const yj = py[j];
      if (yi > y !== yj > y) {
        const xCross = px[i] + ((y - yi) / (yj - yi)) * (px[j] - px[i]);
        if (x < xCross) hit = !hit;
      }
    }
    return hit;
  };

  for (let iy = 0; iy < grid.h; iy++) {
    const y = y1 - ((iy + 0.5) / grid.h) * (y1 - y0);
    for (let ix = 0; ix < grid.w; ix++) {
      const x = x0 + ((ix + 0.5) / grid.w) * (x1 - x0);
      if (!inside(x, y)) grid.z[iy * grid.w + ix] = NaN;
    }
  }
}

/** Binary min-heap keyed on number — for the priority-flood fill. */
class MinHeap {
  keys: number[] = [];
  vals: number[] = [];
  size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.keys;
    const v = this.vals;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop() as number;
    const lv = v.pop() as number;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Priority-flood depression filling: water level each cell would fill to
 * before spilling off the edge of the selected area. Depth = level − ground.
 * Cells at the boundary (or beside no-data) drain freely.
 */
function pondingDepths(g: DtmGrid): Float32Array {
  const { w, h, z } = g;
  const n = w * h;
  const fill = new Float32Array(n).fill(Infinity);
  const seen = new Uint8Array(n);
  const heap = new MinHeap();

  const seed = (i: number) => {
    if (!seen[i]) {
      seen[i] = 1;
      fill[i] = Number.isNaN(z[i]) ? -Infinity : z[i];
      heap.push(fill[i], i);
    }
  };
  // Boundary cells drain off the edge…
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  // …and so does anything beside a no-data hole (unknown ground — be safe).
  for (let i = 0; i < n; i++) if (Number.isNaN(z[i])) seed(i);

  const nb = [-1, 1, -w, w];
  while (heap.size()) {
    const [level, i] = heap.pop();
    const x = i % w;
    for (const d of nb) {
      const j = i + d;
      if (j < 0 || j >= n) continue;
      if (d === -1 && x === 0) continue;
      if (d === 1 && x === w - 1) continue;
      if (seen[j]) continue;
      seen[j] = 1;
      const zj = Number.isNaN(z[j]) ? -Infinity : z[j];
      fill[j] = Math.max(zj, level);
      heap.push(fill[j], j);
    }
  }

  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    depth[i] = Number.isNaN(z[i]) ? 0 : Math.max(0, fill[i] - z[i]);
  }
  return depth;
}

export function analyseLevels(grid: DtmGrid, sourceName: string): LevelsAnalysis {
  const { z, w, h } = grid;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minI = -1;
  let maxI = -1;
  for (let i = 0; i < z.length; i++) {
    const v = z[i];
    if (Number.isNaN(v)) continue;
    if (v < minZ) {
      minZ = v;
      minI = i;
    }
    if (v > maxZ) {
      maxZ = v;
      maxI = i;
    }
  }

  const depth = pondingDepths(grid);
  let maxDepth = 0;
  let maxDepthI = -1;
  let ponded = 0;
  let valid = 0;
  for (let i = 0; i < depth.length; i++) {
    if (Number.isNaN(z[i])) continue;
    valid++;
    if (depth[i] > 0.02) ponded++;
    if (depth[i] > maxDepth) {
      maxDepth = depth[i];
      maxDepthI = i;
    }
  }

  return {
    grid,
    minZ,
    maxZ,
    minPt: cellLatLng(grid, minI % w, Math.floor(minI / w)),
    maxPt: cellLatLng(grid, maxI % w, Math.floor(maxI / w)),
    depth,
    maxDepth,
    maxDepthPt:
      maxDepth > 0.02 && maxDepthI >= 0
        ? cellLatLng(grid, maxDepthI % w, Math.floor(maxDepthI / w))
        : null,
    pondFraction: valid ? ponded / valid : 0,
    sourceName,
  };
}

// ------------------------------------------------------------- rendering

/**
 * Render the analysis to a north-up PNG: hypsometric elevation tint, contour
 * lines (marching squares), and blue ponding shading scaled by depth.
 * Returned as a data URL to overlay on the map (rotation 0).
 */
export function renderLevelsImage(
  a: LevelsAnalysis,
  contourIntervalM: number
): string {
  const { grid, depth, minZ, maxZ } = a;
  const { w, h, z } = grid;
  const scale = 3; // supersample so contour lines stay crisp when zoomed
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // --- elevation tint + ponding, one image pixel per cell, then upscale ---
  const base = document.createElement("canvas");
  base.width = w;
  base.height = h;
  const bctx = base.getContext("2d");
  if (!bctx) throw new Error("Canvas 2D context unavailable");
  const imgData = bctx.createImageData(w, h);
  const px = imgData.data;
  const range = Math.max(0.01, maxZ - minZ);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (Number.isNaN(z[i])) {
      px[o + 3] = 0;
      continue;
    }
    const t = (z[i] - minZ) / range; // 0 low → 1 high
    // Low = deep green, mid = tan, high = warm brown (hypsometric-ish).
    const r = Math.round(70 + 175 * t);
    const gC = Math.round(140 + 40 * t - 60 * t * t);
    const b = Math.round(70 + 20 * t);
    px[o] = r;
    px[o + 1] = gC;
    px[o + 2] = b;
    px[o + 3] = 235;
    const d = depth[i];
    if (d > 0.02) {
      // Blend ponding blue over the tint; deeper = more opaque blue.
      const alpha = Math.min(0.9, 0.35 + d * 0.8);
      px[o] = Math.round(px[o] * (1 - alpha) + 30 * alpha);
      px[o + 1] = Math.round(px[o + 1] * (1 - alpha) + 110 * alpha);
      px[o + 2] = Math.round(px[o + 2] * (1 - alpha) + 220 * alpha);
    }
  }
  bctx.putImageData(imgData, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);

  // --- contours (marching squares on cell corners) ---
  const zAt = (x: number, y: number) => z[y * w + x];
  const firstLevel = Math.ceil(minZ / contourIntervalM) * contourIntervalM;
  ctx.lineCap = "round";
  for (let level = firstLevel, li = 0; level <= maxZ; level += contourIntervalM, li++) {
    const index = Math.abs(level % (contourIntervalM * 5)) < 1e-6;
    ctx.strokeStyle = index ? "rgba(60,35,10,0.9)" : "rgba(80,50,20,0.55)";
    ctx.lineWidth = index ? 2.2 : 1.1;
    ctx.beginPath();
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const v00 = zAt(x, y);
        const v10 = zAt(x + 1, y);
        const v01 = zAt(x, y + 1);
        const v11 = zAt(x + 1, y + 1);
        if (
          Number.isNaN(v00) ||
          Number.isNaN(v10) ||
          Number.isNaN(v01) ||
          Number.isNaN(v11)
        )
          continue;
        let code = 0;
        if (v00 >= level) code |= 8;
        if (v10 >= level) code |= 4;
        if (v11 >= level) code |= 2;
        if (v01 >= level) code |= 1;
        if (code === 0 || code === 15) continue;
        // Interpolated crossing points on each edge (in supersampled px).
        const lerp = (va: number, vb: number) => (level - va) / (vb - va);
        const top = [x + lerp(v00, v10), y] as const;
        const right = [x + 1, y + lerp(v10, v11)] as const;
        const bottom = [x + lerp(v01, v11), y + 1] as const;
        const leftE = [x, y + lerp(v00, v01)] as const;
        const segs: (readonly [number, number])[][] = [];
        switch (code) {
          case 1:
          case 14:
            segs.push([leftE, bottom]);
            break;
          case 2:
          case 13:
            segs.push([bottom, right]);
            break;
          case 3:
          case 12:
            segs.push([leftE, right]);
            break;
          case 4:
          case 11:
            segs.push([top, right]);
            break;
          case 5:
            segs.push([leftE, top], [bottom, right]);
            break;
          case 6:
          case 9:
            segs.push([top, bottom]);
            break;
          case 7:
          case 8:
            segs.push([leftE, top]);
            break;
          case 10:
            segs.push([top, right], [leftE, bottom]);
            break;
        }
        for (const [p1, p2] of segs) {
          ctx.moveTo((p1[0] + 0.5) * scale, (p1[1] + 0.5) * scale);
          ctx.lineTo((p2[0] + 0.5) * scale, (p2[1] + 0.5) * scale);
        }
      }
    }
    ctx.stroke();
  }

  return canvas.toDataURL("image/png");
}
