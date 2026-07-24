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

## Design layout overlay

**📐 Superimpose design layout** overlays a proposed layout plan (PNG/JPG —
export PDF or CAD sheets as an image first) on the map so the splay can be
drawn and checked against the **new design lines** rather than the existing
road:

1. Upload the image — it appears semi-transparent at the map centre with
   **Adjust** mode on: drag the round handle to move the plan, the square
   corner handle to rotate & scale, until the plan's existing-road features
   sit on the aerial imagery.
2. **Calibrate scale** for accuracy: measure a known length on the overlaid
   plan (its scale bar or a dimensioned line) with the 📏 Measure tool, type
   the true length, Apply. Opacity, rotation and width are also directly
   editable.
3. Turn Adjust off and draw the splay as usual — clicks pass straight through
   the overlay, so place the junction mouth, Point A and the Y points on the
   *proposed* kerb lines. Pass/fail then reports against the new design.

The overlay is saved with the assessment (subject to browser-storage size —
very large images are dropped from the save with a warning) and is included
in the PNG export. Note the 3D sightline check still tests against the
*existing* 3D tiles, so it reflects current features, not the proposed works.

## Ground levels & ponding (EA LiDAR)

**⛰ Analyse ground levels in an area** — click two corners of a box on the
map (up to 500 m square) and the tool fetches the **Environment Agency LiDAR
composite DTM** (bare-earth, ±5–15 cm vertical, open data, England only — no
API key needed) and overlays:

- a hypsometric elevation tint with **contours** (0.1 / 0.25 / 0.5 / 1 m
  interval, index contours emphasised),
- **▼ lowest** and **▲ highest** ground markers (m AOD),
- **💧 predicted ponding** — a priority-flood depression fill shades where
  water would collect before spilling out of the selected area, deeper =
  more opaque blue, with the deepest point marked.

The panel reports lowest/highest ground, deepest ponding and the ponded
fraction of the area; the overlay is included in the PNG export with a
summary row. The EA image service is discovered at runtime from the Defra
services directory, so new composite releases are picked up automatically.
Levels reflect *existing* ground at the LiDAR survey date — a desktop
indicator, not a substitute for a topographical survey.

## Architecture notes

- `lib/standards.ts` — all standards values (SSD tables, X options, eye
  heights) with source comments. Components never hardcode standards values.
  Values are provisional — `TODO: verify against MfS Table 7.1 and CD 109`.
- `lib/storage.ts` — persistence behind an `AssessmentStore` interface
  (localStorage now, Supabase swappable later).
- `lib/geo.ts` — geodesic helpers over `google.maps.geometry.spherical`.
- `lib/export.ts` — PNG export (html2canvas capture + vector redraw +
  parameters block).

## 3D sightline check

**🔎 3D sightline check** (Tools) opens a CesiumJS panel using Google
Photorealistic 3D Tiles and runs an **automated line-of-sight test** on each
splay leg. It samples the 3D-tile surface at ~1 m steps along A→B and A→C and
checks whether anything (ground, hedge, fence, building) rises above the
straight line from the driver eye (`ground + eye height`) to the object at Y
(`ground + object height`). The sightlines are drawn over an orbit view
(green = clear, red = obstructed) with a ⚠ marker at the worst obstruction;
driver's-seat views (left / ahead / right) are also available. There is
deliberately no textual CLEAR/OBSTRUCTED verdict box — the photogrammetry is
too noisy for that to be trusted, so read the coloured scene and judge.

Because the tiles are aerial photogrammetry, the *picture* is smeared at eye
level and includes trees/parked cars, so treat the result as a desktop
indicator and verify on site. Eye height and object height come from the
**Sightline heights** control.

> Requires the **Map Tiles API** enabled on the Google key. Cesium's runtime
> assets are copied to `public/cesium` automatically on `npm install`
> (`npm run copy-cesium` to redo it).

## Roadmap

- **Phase 1** — 2D map splay tool ✅
- **3D automated sightline check** (CesiumJS + Google 3D Tiles) ✅
- **Future** — line-of-sight testing against Environment Agency LiDAR DSM
  (bare-earth + surface, less noisy than photogrammetry)
