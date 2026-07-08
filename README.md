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
   - **Map Tiles API** (Phase 3 — photorealistic 3D tiles; can wait)
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

## Street View inspection (Phase 2)

Once a splay is drawn, **Inspect in Street View** (Tools) opens a panorama
beside the map at Point A, facing the Y point, with the sightline overlaid as
a receding trail of markers to the Y endpoint so you can pan and judge whether
a hedge / fence / building cuts the line. Toggle the left/right leg, and click
anywhere along the sightline on the map to move the camera to the nearest
panorama (it snaps to the A→Y line and keeps facing Y). A persistent chip warns
that the Street View camera (~2.5 m) sits well above driver eye height
(1.05 m), and the imagery capture date is shown with a staleness warning when
it is over two years old.

## Roadmap

- **Phase 1** — 2D map splay tool ✅
- **Phase 2** — Street View sightline inspection ✅
- **Phase 3** — 3D photorealistic tiles (CesiumJS) with sightline curtains
- **Phase 4** (future) — automated line-of-sight testing against Environment
  Agency LiDAR DSM
