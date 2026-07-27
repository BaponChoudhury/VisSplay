/**
 * Server-side proxy for Environment Agency LiDAR terrain data.
 *
 * The EA endpoints (ArcGIS REST and OGC WCS on environment.data.gov.uk) do
 * not send CORS headers, so a browser fetch is rejected before it starts
 * ("Failed to fetch"). This route runs on the server, where the same-origin
 * policy does not apply, and hands the raster back to the page as a GeoTIFF.
 *
 * It tries the known ways of getting *values* (not a rendered picture) in
 * order and reports what every attempt returned, so a failure is diagnosable
 * rather than a dead end.
 */

import { NextRequest } from "next/server";

export const runtime = "nodejs";
// Elevation data for a fixed area never changes; let Vercel cache it.
export const revalidate = 86400;

const REST_ROOT = "https://environment.data.gov.uk/image/rest/services";
const WCS_BASE = "https://environment.data.gov.uk/spatialdata";

/** Known service paths, finest grid first. Discovery runs first; these are
 *  the documented fallbacks if the directory listing is unhelpful. */
const KNOWN_ARCGIS = [
  "SURVEY/LIDARCompositeDTM1m2022",
  "SURVEY/LIDARCompositeDTM2m2022",
];
const WCS_SLUGS = [
  "lidar-composite-digital-terrain-model-dtm-1m",
  "lidar-composite-digital-terrain-model-dtm-2m",
];

const UPSTREAM_TIMEOUT_MS = 12000;

interface Attempt {
  label: string;
  detail: string;
}

async function get(url: string, accept: string): Promise<Response> {
  return fetch(url, {
    headers: { Accept: accept, "User-Agent": "SplayCheck/1.0 (+levels)" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    next: { revalidate },
  });
}

/** A TIFF starts with "II"/"MM"; anything else is an error document. */
function tiffOrError(buf: ArrayBuffer): { ok: true } | { ok: false; msg: string } {
  const head = new Uint8Array(buf.slice(0, 2));
  const magic = String.fromCharCode(head[0] ?? 0, head[1] ?? 0);
  if (magic === "II" || magic === "MM") return { ok: true };
  const text = new TextDecoder().decode(buf.slice(0, 1500)).trim();
  try {
    const j = JSON.parse(text) as { error?: { message?: string } };
    if (j.error?.message) return { ok: false, msg: j.error.message };
  } catch {
    /* not JSON */
  }
  const xml = /<(?:ows:)?ExceptionText[^>]*>([^<]+)</.exec(text);
  return { ok: false, msg: (xml?.[1] ?? text).slice(0, 200) || "empty response" };
}

/** ArcGIS ImageServer returns raw values; a MapServer only renders pictures. */
async function tryImageServer(
  servicePath: string,
  bboxMerc: string,
  w: number,
  h: number,
  attempts: Attempt[]
): Promise<ArrayBuffer | null> {
  const params = new URLSearchParams({
    f: "image",
    bbox: bboxMerc,
    bboxSR: "3857",
    imageSR: "3857",
    size: `${w},${h}`,
    format: "tiff",
    pixelType: "F32",
    interpolation: "RSP_BilinearInterpolation",
  });
  const label = `ImageServer ${servicePath.split("/").pop()}`;
  try {
    const res = await get(
      `${REST_ROOT}/${servicePath}/ImageServer/exportImage?${params}`,
      "image/tiff"
    );
    if (!res.ok) {
      attempts.push({ label, detail: `HTTP ${res.status}` });
      return null;
    }
    const buf = await res.arrayBuffer();
    const check = tiffOrError(buf);
    if (!check.ok) {
      attempts.push({ label, detail: check.msg });
      return null;
    }
    return buf;
  } catch (e) {
    attempts.push({ label, detail: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** First CoverageId advertised by a WCS service. */
function firstTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([^<]+)<`, "i").exec(xml);
  return m ? m[1].trim() : null;
}

function attrOf(xml: string, attr: string): string | null {
  const m = new RegExp(`${attr}="([^"]+)"`, "i").exec(xml);
  return m ? m[1].trim() : null;
}

/**
 * OGC WCS 2.0.1 GetCoverage — the documented route to elevation values.
 * Axis labels differ between service releases, so they are read from the
 * capabilities/description rather than assumed.
 */
async function tryWcs(
  slug: string,
  box: { south: number; west: number; north: number; east: number },
  w: number,
  h: number,
  attempts: Attempt[]
): Promise<ArrayBuffer | null> {
  const base = `${WCS_BASE}/${slug}/wcs`;
  const label = `WCS ${slug.replace("lidar-composite-digital-terrain-model-", "")}`;
  try {
    const capRes = await get(
      `${base}?service=WCS&version=2.0.1&request=GetCapabilities`,
      "application/xml"
    );
    if (!capRes.ok) {
      attempts.push({ label, detail: `GetCapabilities HTTP ${capRes.status}` });
      return null;
    }
    const capXml = await capRes.text();
    const coverageId = firstTag(capXml, "CoverageId");
    if (!coverageId) {
      attempts.push({
        label,
        detail: `no CoverageId (got ${capXml.slice(0, 120)})`,
      });
      return null;
    }

    let axes = ["Lat", "Long"];
    try {
      const descRes = await get(
        `${base}?service=WCS&version=2.0.1&request=DescribeCoverage&coverageId=${encodeURIComponent(coverageId)}`,
        "application/xml"
      );
      if (descRes.ok) {
        const labels = attrOf(await descRes.text(), "axisLabels");
        if (labels) axes = labels.split(/\s+/).filter(Boolean);
      }
    } catch {
      /* keep defaults */
    }

    const isLat = (a: string) => /^(lat|n\b|y)/i.test(a);
    const range = (a: string) =>
      isLat(a) ? `${box.south},${box.north}` : `${box.west},${box.east}`;
    const size = (a: string) => (isLat(a) ? h : w);

    // Try the richest request first, then progressively simpler ones — some
    // deployments reject scaleSize or an explicit outputCrs.
    const variants: string[] = [
      [
        ...axes.map((a) => `subset=${encodeURIComponent(a)}(${range(a)})`),
        "subsettingCrs=http://www.opengis.net/def/crs/EPSG/0/4326",
        "outputCrs=http://www.opengis.net/def/crs/EPSG/0/3857",
        `scaleSize=${encodeURIComponent(axes.map((a) => `${a}(${size(a)})`).join(","))}`,
      ].join("&"),
      [
        ...axes.map((a) => `subset=${encodeURIComponent(a)}(${range(a)})`),
        "subsettingCrs=http://www.opengis.net/def/crs/EPSG/0/4326",
        "outputCrs=http://www.opengis.net/def/crs/EPSG/0/4326",
      ].join("&"),
      axes.map((a) => `subset=${encodeURIComponent(a)}(${range(a)})`).join("&"),
    ];

    for (let i = 0; i < variants.length; i++) {
      const url =
        `${base}?service=WCS&version=2.0.1&request=GetCoverage` +
        `&coverageId=${encodeURIComponent(coverageId)}&format=image/tiff&${variants[i]}`;
      const res = await get(url, "image/tiff");
      if (!res.ok) {
        attempts.push({ label: `${label} v${i + 1}`, detail: `HTTP ${res.status}` });
        continue;
      }
      const buf = await res.arrayBuffer();
      const check = tiffOrError(buf);
      if (check.ok) return buf;
      attempts.push({ label: `${label} v${i + 1}`, detail: check.msg });
    }
    return null;
  } catch (e) {
    attempts.push({ label, detail: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Discover an ImageServer-published DTM, if one exists. Best effort. */
async function discoverArcgisPaths(attempts: Attempt[]): Promise<string[]> {
  try {
    const res = await get(`${REST_ROOT}?f=json`, "application/json");
    if (!res.ok) {
      attempts.push({ label: "directory", detail: `HTTP ${res.status}` });
      return [];
    }
    const root = (await res.json()) as {
      folders?: string[];
      services?: { name: string; type: string }[];
    };
    const found: { name: string; type: string }[] = [...(root.services ?? [])];
    const folders = (root.folders ?? []).filter((f) =>
      /survey|lidar|elevation|terrain/i.test(f)
    );
    for (const f of folders.slice(0, 4)) {
      const r = await get(`${REST_ROOT}/${f}?f=json`, "application/json");
      if (!r.ok) continue;
      const d = (await r.json()) as { services?: { name: string; type: string }[] };
      if (d.services) found.push(...d.services);
    }
    const dtm = found
      .filter(
        (s) =>
          /dtm|terrain/i.test(s.name) &&
          !/dsm|hillshade|slope|aspect|contour/i.test(s.name)
      )
      .map((s) => s.name);
    if (!dtm.length) {
      attempts.push({
        label: "directory",
        detail: `no DTM among ${found.length} services`,
      });
    }
    return dtm;
  } catch (e) {
    attempts.push({
      label: "directory",
      detail: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const num = (k: string) => Number(p.get(k));
  const south = num("s");
  const west = num("w");
  const north = num("n");
  const east = num("e");
  const px = Math.max(8, Math.min(1600, Math.round(num("px") || 0)));
  const py = Math.max(8, Math.min(1600, Math.round(num("py") || 0)));

  if (![south, west, north, east].every(Number.isFinite) || !px || !py) {
    return Response.json({ error: "Bad or missing bounds." }, { status: 400 });
  }

  const R = 6378137;
  const mercX = (lng: number) => (R * lng * Math.PI) / 180;
  const mercY = (lat: number) =>
    R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const bboxMerc = [mercX(west), mercY(south), mercX(east), mercY(north)].join(",");

  const attempts: Attempt[] = [];
  let buf: ArrayBuffer | null = null;
  let source = "";

  const discovered = await discoverArcgisPaths(attempts);
  const paths = Array.from(new Set([...discovered, ...KNOWN_ARCGIS]));
  for (const path of paths.slice(0, 4)) {
    buf = await tryImageServer(path, bboxMerc, px, py, attempts);
    if (buf) {
      source = path.split("/").pop() ?? path;
      break;
    }
  }

  if (!buf) {
    for (const slug of WCS_SLUGS) {
      buf = await tryWcs(slug, { south, west, north, east }, px, py, attempts);
      if (buf) {
        source = slug.replace("lidar-composite-digital-terrain-model-", "EA DTM ");
        break;
      }
    }
  }

  if (!buf) {
    return Response.json(
      {
        error: "No EA LiDAR endpoint returned elevation data.",
        attempts,
      },
      { status: 502 }
    );
  }

  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": "image/tiff",
      "X-Lidar-Source": source,
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
    },
  });
}
