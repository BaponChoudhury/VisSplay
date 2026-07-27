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
// Several upstream attempts may run before one succeeds.
export const maxDuration = 60;
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

const UPSTREAM_TIMEOUT_MS = 7000;

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

/** Short, readable summary of a failed response body (XML/JSON/text). */
async function bodySummary(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    if (!text) return "empty body";
    const xml = /<(?:\w+:)?(?:ExceptionText|ServiceException|Message)[^>]*>([^<]+)</i.exec(
      text
    );
    if (xml) return xml[1].trim().slice(0, 220);
    try {
      const j = JSON.parse(text) as {
        error?: { message?: string; details?: string[] };
      };
      if (j.error?.message) {
        return [j.error.message, ...(j.error.details ?? [])].join("; ").slice(0, 220);
      }
    } catch {
      /* not JSON */
    }
    return text.replace(/\s+/g, " ").slice(0, 220);
  } catch {
    return "unreadable body";
  }
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
      attempts.push({
        label,
        detail: `HTTP ${res.status} - ${await bodySummary(res)}`,
      });
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
      attempts.push({
        label,
        detail: `GetCapabilities HTTP ${capRes.status} - ${await bodySummary(capRes)}`,
      });
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
        attempts.push({
          label: `${label} v${i + 1}`,
          detail: `HTTP ${res.status} - ${await bodySummary(res)}`,
        });
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

/**
 * OGC WCS 1.0.0 GetCoverage. Much simpler than 2.0.1 — a plain bbox plus
 * width/height, with no axis-label or subset-CRS negotiation to get wrong —
 * and still widely supported, so it is tried first.
 */
async function tryWcs100(
  slug: string,
  box: { south: number; west: number; north: number; east: number },
  w: number,
  h: number,
  attempts: Attempt[]
): Promise<ArrayBuffer | null> {
  const base = `${WCS_BASE}/${slug}/wcs`;
  const label = `WCS1.0 ${slug.replace("lidar-composite-digital-terrain-model-", "")}`;
  try {
    const capRes = await get(
      `${base}?service=WCS&version=1.0.0&request=GetCapabilities`,
      "application/xml"
    );
    if (!capRes.ok) {
      attempts.push({
        label,
        detail: `GetCapabilities HTTP ${capRes.status} - ${await bodySummary(capRes)}`,
      });
      return null;
    }
    const capXml = await capRes.text();
    // In 1.0.0 the coverage is identified by <name> inside CoverageOfferingBrief.
    const name =
      /<(?:\w+:)?CoverageOfferingBrief[\s\S]*?<(?:\w+:)?name[^>]*>([^<]+)</i.exec(
        capXml
      )?.[1]?.trim() ?? firstTag(capXml, "name");
    if (!name) {
      attempts.push({ label, detail: `no coverage name (${capXml.slice(0, 120)})` });
      return null;
    }

    // bbox is minx,miny,maxx,maxy in the given CRS (lon/lat for EPSG:4326).
    const variants = [
      `coverage=${encodeURIComponent(name)}&bbox=${box.west},${box.south},${box.east},${box.north}` +
        `&crs=EPSG:4326&response_crs=EPSG:4326&format=GeoTIFF&width=${w}&height=${h}`,
      `coverage=${encodeURIComponent(name)}&bbox=${box.west},${box.south},${box.east},${box.north}` +
        `&crs=EPSG:4326&format=image/tiff&width=${w}&height=${h}`,
    ];
    for (let i = 0; i < variants.length; i++) {
      const res = await get(
        `${base}?service=WCS&version=1.0.0&request=GetCoverage&${variants[i]}`,
        "image/tiff"
      );
      if (!res.ok) {
        attempts.push({
          label: `${label} v${i + 1}`,
          detail: `HTTP ${res.status} - ${await bodySummary(res)}`,
        });
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

/**
 * Last-ditch diagnostics: ask the published MapServer to describe itself.
 * It cannot supply elevation values, but its JSON says whether the service
 * exists at all and what it is called, which is what a failure needs to show.
 */
async function probeMapServer(attempts: Attempt[]): Promise<void> {
  for (const path of KNOWN_ARCGIS.slice(0, 1)) {
    try {
      const res = await get(`${REST_ROOT}/${path}/MapServer?f=json`, "application/json");
      const body = await bodySummary(res);
      attempts.push({
        label: `MapServer ${path.split("/").pop()}`,
        detail: `HTTP ${res.status} - ${body.slice(0, 160)}`,
      });
    } catch (e) {
      attempts.push({
        label: "MapServer probe",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
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
    const rootText = await res.text();
    let root: { folders?: string[]; services?: { name: string; type: string }[] };
    try {
      root = JSON.parse(rootText);
    } catch {
      attempts.push({
        label: "directory",
        detail: `not JSON: ${rootText.replace(/\s+/g, " ").slice(0, 160)}`,
      });
      return [];
    }
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
        detail:
          `no DTM among ${found.length} services; ` +
          `folders=[${(root.folders ?? []).slice(0, 8).join(", ")}]`,
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

  const box = { south, west, north, east };
  const dtmName = (slug: string) =>
    slug.replace("lidar-composite-digital-terrain-model-", "EA DTM ");

  // WCS 1.0.0 first: the simplest syntax, so the least to get wrong.
  for (const slug of WCS_SLUGS) {
    buf = await tryWcs100(slug, box, px, py, attempts);
    if (buf) {
      source = dtmName(slug);
      break;
    }
  }

  // Then WCS 2.0.1.
  if (!buf) {
    for (const slug of WCS_SLUGS) {
      buf = await tryWcs(slug, box, px, py, attempts);
      if (buf) {
        source = dtmName(slug);
        break;
      }
    }
  }

  // Then an ImageServer, if the data happens to be published as one.
  if (!buf) {
    const discovered = await discoverArcgisPaths(attempts);
    const paths = Array.from(new Set([...discovered, ...KNOWN_ARCGIS]));
    for (const path of paths.slice(0, 3)) {
      buf = await tryImageServer(path, bboxMerc, px, py, attempts);
      if (buf) {
        source = path.split("/").pop() ?? path;
        break;
      }
    }
  }

  if (!buf) {
    await probeMapServer(attempts);
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
