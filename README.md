# SplayCheck

Visibility splay assessment tool for UK highway engineers. Draw and check
junction visibility splays (Manual for Streets / DMRB CD 109) directly on
Google Maps — a desktop feasibility check ahead of a measured topographical
survey.

> **Disclaimer:** desktop feasibility check only — not a substitute for a
> measured topographical survey and speed survey.

## Setup

1. `npm install`
2. Copy `.env.local.example` to `.env.local` and set
   `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.
3. In Google Cloud Console, enable on the key's project:
   - **Maps JavaScript API** (map, drawing, geometry, Street View)
   - **Places API (New)** (address/postcode search)
   - **Map Tiles API** (Phase 3 — 3D driver's-eye view / photorealistic tiles)
4. `npm run dev` → http://localhost:3000

## Using the tool (Phase 1)

1. Search for the site, or pan/zoom to the junction (satellite by default).
2. Pick parameters: standard (MfS / CD 109 / Manual), major-road speed
   (auto-fills required Y from the SSD table, interpolated for custom
   speeds, always overridable), X setback (2.4 standard / 2.0 minimum with
   warning / 4.5 no-encroachment / custom).
3. **Guided mode** — click the junction mouth, then Point A (snapped X metres
   back along your cursor direction); both Y handles appear at the required
   distance, drag them along the nearer kerb. Green = pass, red = fail.
   **3-point mode** — click junction mouth, A, B (left Y), C (right Y).
   All vertices stay draggable. `Esc` cancels, `Enter` confirms.
4. Measure tool for kerb offsets; save/load assessments (browser
   localStorage); export a PNG with the splay and a parameters summary.

## Architecture notes

- `lib/standards.ts` — all standards values (SSD tables, X options, eye
  heights) with source comments. Components never hardcode standards values.
  Values are provisional — `TODO: verify against MfS Table 7.1 and CD 109`.
- `lib/storage.ts` — persistence behind an `AssessmentStore` interface
  (localStorage now, Supabase swappable later).
- `lib/geo.ts` — geodesic helpers over `google.maps.geometry.spherical`.
- `lib/export.ts` — PNG export (html2canvas capture + vector redraw +
  parameters block).

## 3D driver's-eye view

**🚗 3D driver's-eye view** (Tools) opens a CesiumJS panel using Google
Photorealistic 3D Tiles. The camera sits **at the vehicle — Point A (the X
setback) — at the driver eye height** (1.05–2.0 m, from the Sightline heights
control). **Both** sightlines are drawn — the line of sight to the left Y point
(B) and to the right Y point (C) — each with a translucent red "curtain" from
the object height up to 2.0 m along the leg, so you can see whether a hedge,
fence or building intersects either sightline. The driver looks ahead toward
the junction by default; use **Look ◀ Left / Ahead / Right ▶** to snap the
view to each side, or **Orbit** for a bird's-eye of the whole splay. Raising
the eye height lifts the camera in place — it does not move the car. Clash
judgement is visual in this phase.

> Requires the **Map Tiles API** enabled on the Google key. Cesium's runtime
> assets are copied to `public/cesium` automatically on `npm install`
> (`npm run copy-cesium` to redo it).

## Roadmap

- **Phase 1** — 2D map splay tool ✅
- **3D driver's-eye view** (CesiumJS + Google 3D Tiles) ✅
- **Future** — automated line-of-sight testing against Environment Agency
  LiDAR DSM
