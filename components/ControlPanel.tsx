"use client";

/**
 * Left input panel: search, drawing controls, standards parameters, live
 * results, tools, save/load and export. Pure UI — all state lives in
 * SplayCheckApp; all standards values come from lib/standards.ts.
 */

import { useState } from "react";
import type {
  DesignOverlaySettings,
  SavedAssessment,
  SplayParams,
  StandardId,
} from "@/lib/types";
import {
  DRIVER_EYE_HEIGHT_RANGE_M,
  EXPORT_DISCLAIMER,
  OBJECT_HEIGHT_MAX_M,
  OBJECT_HEIGHT_RANGE_M,
  STANDARD_LABELS,
  X_DISTANCE_OPTIONS,
  clamp,
  kphToMph,
  mphToKph,
  ssdForSpeed,
  tableFor,
} from "@/lib/standards";
import { formatM } from "@/lib/geo";
import type { Mode, SplayResults, Step } from "./SplayCheckApp";

interface Props {
  open: boolean;
  onToggleOpen: () => void;
  mapsStatus: string;
  mode: Mode;
  step: Step;
  lockDistances: boolean;
  onLockDistances: (v: boolean) => void;
  onStartDrawing: (mode: Mode) => void;
  onReset: () => void;
  params: SplayParams;
  onUpdateParams: (patch: Partial<SplayParams>) => void;
  results: SplayResults;
  measuring: boolean;
  measureDist: number | null;
  onToggleMeasure: () => void;
  design: DesignOverlaySettings | null;
  designAdjust: boolean;
  onDesignFile: (file: File) => void;
  onDesignUpdate: (patch: Partial<DesignOverlaySettings>) => void;
  onDesignAdjust: (v: boolean) => void;
  onDesignRemove: () => void;
  mapType: "hybrid" | "roadmap";
  onMapType: (t: "hybrid" | "roadmap") => void;
  siteName: string;
  onSiteName: (v: string) => void;
  onSave: () => void;
  onSaveAsNew: () => void;
  canExport: boolean;
  exporting: boolean;
  onExport: () => void;
  canInspect: boolean;
  threeDOpen: boolean;
  onInspect3D: () => void;
  saved: SavedAssessment[];
  currentId: string | null;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}

const sectionCls =
  "border-b border-slate-800 px-4 py-3.5";
const headingCls =
  "mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500";
const btnBase =
  "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const btnPrimary = `${btnBase} bg-sky-600 text-white hover:bg-sky-500`;
const btnSecondary = `${btnBase} bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700`;
const inputCls =
  "w-full rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none";

export default function ControlPanel(props: Props) {
  const { open, onToggleOpen, params, onUpdateParams, results } = props;
  const [speedUnit, setSpeedUnit] = useState<"mph" | "kph">("mph");
  const [customX, setCustomX] = useState(false);

  const table = tableFor(params.standard);
  const tableMatch = table?.find((r) => r.kph === params.speedKph);
  const speedSelectValue = tableMatch ? String(tableMatch.kph) : "custom";
  const ssd =
    params.standard !== "manual"
      ? ssdForSpeed(params.standard, params.speedKph)
      : null;
  const presetX = X_DISTANCE_OPTIONS.some((o) => o.value === params.xDistance);
  const xWarning = X_DISTANCE_OPTIONS.find(
    (o) => o.value === params.xDistance
  )?.warning;

  const drawing = props.step !== "idle" && props.step !== "done";

  return (
    <div
      className={`relative z-10 h-full shrink-0 transition-[width] duration-200 ${
        open ? "w-[380px]" : "w-0"
      }`}
    >
      <button
        onClick={onToggleOpen}
        title={open ? "Collapse panel" : "Open panel"}
        className="absolute -right-9 top-3 z-20 flex h-9 w-9 items-center justify-center rounded-r-lg border border-l-0 border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
      >
        {open ? "◀" : "▶"}
      </button>

      <div
        className={`panel-scroll h-full w-[380px] overflow-y-auto border-r border-slate-800 bg-slate-900 ${
          open ? "" : "hidden"
        }`}
      >
        {/* Header */}
        <div className="border-b border-slate-800 px-4 py-3.5">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Splay<span className="text-sky-400">Check</span>
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Visibility splay feasibility — MfS / DMRB CD 109
          </p>
        </div>

        {/* Search */}
        <div className={sectionCls}>
          <div className={headingCls}>Find site</div>
          <div id="splaycheck-search" />
          {props.mapsStatus !== "ready" && (
            <p className="mt-1.5 text-xs text-slate-500">
              Search loads with the map…
            </p>
          )}
        </div>

        {/* Design layout overlay */}
        <DesignOverlaySection
          design={props.design}
          designAdjust={props.designAdjust}
          measuring={props.measuring}
          measureDist={props.measureDist}
          onToggleMeasure={props.onToggleMeasure}
          onFile={props.onDesignFile}
          onUpdate={props.onDesignUpdate}
          onAdjust={props.onDesignAdjust}
          onRemove={props.onDesignRemove}
        />

        {/* Drawing */}
        <div className={sectionCls}>
          <div className={headingCls}>Draw splay</div>
          <div className="flex gap-2">
            <button
              className={`${
                props.mode === "manual" && drawing ? btnPrimary : btnSecondary
              } flex-1`}
              disabled={props.mapsStatus !== "ready"}
              onClick={() => props.onStartDrawing("manual")}
              title="Place every point yourself to measure the achieved sightline"
            >
              Manual
            </button>
            <button
              className={`${
                props.mode === "auto" && drawing ? btnPrimary : btnSecondary
              } flex-1`}
              disabled={props.mapsStatus !== "ready"}
              onClick={() => props.onStartDrawing("auto")}
              title="App draws both Y legs at the required distance; drag onto the kerb with Y locked"
            >
              Automatic
            </button>
            <button className={btnSecondary} onClick={props.onReset}>
              Reset
            </button>
          </div>
          <label
            className={`mt-2.5 flex items-center gap-2 text-sm ${
              props.mode === "auto" ? "text-slate-300" : "text-slate-600"
            }`}
            title="Automatic mode only"
          >
            <input
              type="checkbox"
              checked={props.lockDistances}
              onChange={(e) => props.onLockDistances(e.target.checked)}
              className="accent-sky-500"
            />
            Lock to standard X &amp; Y distances
          </label>
          <div className="mt-2 space-y-1.5 text-xs leading-5 text-slate-500">
            <p>
              <span className="font-semibold text-slate-300">Manual</span> —
              you click the junction mouth, Point A (the driver, kept X back),
              then the left (B) and right (C) Y points where the sightline
              actually reaches. B and C drag freely, so Y is the{" "}
              <span className="text-slate-300">achieved</span> distance and each
              side reports pass/fail against the requirement.
            </p>
            <p>
              <span className="font-semibold text-slate-300">Automatic</span> —
              you click only the junction mouth and Point A. Point A sits X back
              and both Y legs are drawn at the{" "}
              <span className="text-slate-300">required</span> distance.
            </p>
            <p>
              With <span className="text-slate-300">Lock</span> on (default),
              Point A stays exactly X back from the mouth (both modes) and, in
              Automatic, the Y legs stay at the required distance — dragging a
              handle only swings its direction, so you slide A onto the
              minor-arm centreline and each Y handle onto the nearer kerb
              without the distance drifting. Turn{" "}
              <span className="text-slate-300">Lock</span> off to drag freely
              and adjust the actual distances.
            </p>
            {drawing && <p className="text-slate-400">Esc cancels · Enter confirms.</p>}
          </div>
        </div>

        {/* Parameters */}
        <div className={sectionCls}>
          <div className={headingCls}>Standard</div>
          <div className="flex overflow-hidden rounded-md border border-slate-700">
            {(Object.keys(STANDARD_LABELS) as StandardId[]).map((s) => (
              <button
                key={s}
                onClick={() =>
                  onUpdateParams({ standard: s, yOverridden: false })
                }
                className={`flex-1 px-2 py-1.5 text-sm font-medium transition-colors ${
                  params.standard === s
                    ? "bg-sky-600 text-white"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                {STANDARD_LABELS[s]}
              </button>
            ))}
          </div>

          {params.standard !== "manual" && table && (
            <>
              <div className="mt-3 text-xs font-medium text-slate-400">
                Major road speed{" "}
                {params.standard === "cd109" && "(design speed)"}
              </div>
              <select
                className={`${inputCls} mt-1`}
                value={speedSelectValue}
                onChange={(e) => {
                  if (e.target.value !== "custom") {
                    onUpdateParams({ speedKph: Number(e.target.value) });
                  }
                }}
              >
                {table.map((r) => (
                  <option key={r.kph} value={r.kph}>
                    {r.kph} kph ·{" "}
                    {r.mph != null
                      ? `${r.mph} mph`
                      : `≈ ${kphToMph(r.kph).toFixed(0)} mph`}{" "}
                    — SSD {r.ssd} m
                  </option>
                ))}
                <option value="custom">Custom speed…</option>
              </select>
              {speedSelectValue === "custom" && (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className={inputCls}
                    value={
                      speedUnit === "kph"
                        ? Math.round(params.speedKph * 10) / 10
                        : Math.round(kphToMph(params.speedKph) * 10) / 10
                    }
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v) || v <= 0) return;
                      onUpdateParams({
                        speedKph: speedUnit === "kph" ? v : mphToKph(v),
                      });
                    }}
                  />
                  <div className="flex overflow-hidden rounded-md border border-slate-700">
                    {(["mph", "kph"] as const).map((u) => (
                      <button
                        key={u}
                        onClick={() => setSpeedUnit(u)}
                        className={`px-2 py-1.5 text-xs font-medium ${
                          speedUnit === u
                            ? "bg-slate-600 text-white"
                            : "bg-slate-800 text-slate-400"
                        }`}
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <p className="mt-1.5 text-xs text-slate-500">
                {params.speedKph.toFixed(0)} kph ={" "}
                {kphToMph(params.speedKph).toFixed(1)} mph
                {ssd?.interpolated && " · SSD linearly interpolated"}
                {ssd?.clamped && (
                  <span className="text-amber-400">
                    {" "}
                    · outside table range — value clamped, check standard
                    applicability
                  </span>
                )}
              </p>
            </>
          )}

          <div className="mt-3 text-xs font-medium text-slate-400">
            X distance (minor-arm setback)
          </div>
          <div className="mt-1 flex gap-1.5">
            {X_DISTANCE_OPTIONS.map((o) => (
              <button
                key={o.value}
                title={o.note}
                onClick={() => {
                  setCustomX(false);
                  onUpdateParams({ xDistance: o.value });
                }}
                className={`${btnBase} flex-1 border ${
                  params.xDistance === o.value && !customX
                    ? "border-sky-500 bg-sky-600/20 text-sky-300"
                    : "border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                {o.label}
              </button>
            ))}
            <button
              onClick={() => setCustomX(true)}
              className={`${btnBase} flex-1 border ${
                customX || !presetX
                  ? "border-sky-500 bg-sky-600/20 text-sky-300"
                  : "border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              Custom
            </button>
          </div>
          {(customX || !presetX) && (
            <input
              type="number"
              min={0.5}
              step={0.1}
              className={`${inputCls} mt-2`}
              value={params.xDistance}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0)
                  onUpdateParams({ xDistance: v });
              }}
            />
          )}
          {xWarning && (
            <p className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
              ⚠ 2.0 m is an absolute minimum — justify for lightly trafficked /
              low-speed situations only.
            </p>
          )}

          <div className="mt-3 text-xs font-medium text-slate-400">
            Required Y distance (SSD)
          </div>
          {params.standard === "manual" || params.yOverridden ? (
            <input
              type="number"
              min={1}
              step={0.5}
              className={`${inputCls} mt-1`}
              value={params.yRequired}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0)
                  onUpdateParams({ yRequired: v, yOverridden: true });
              }}
            />
          ) : (
            <div className="mt-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm font-semibold text-slate-100">
              {params.yRequired.toFixed(1)} m{" "}
              <span className="font-normal text-slate-500">
                each side, from table
              </span>
            </div>
          )}
          {params.standard !== "manual" && (
            <label className="mt-1.5 flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                className="accent-sky-500"
                checked={params.yOverridden}
                onChange={(e) =>
                  onUpdateParams({ yOverridden: e.target.checked })
                }
              />
              Override Y (e.g. from measured 85th percentile speeds)
            </label>
          )}
        </div>

        {/* Results */}
        <div className={sectionCls}>
          <div className={headingCls}>Results</div>
          <ResultRow
            label="Y required"
            value={`${params.yRequired.toFixed(1)} m`}
          />
          <ResultRow
            label="Y left (A–B side)"
            value={formatM(results.yLeft)}
            pass={results.passLeft}
          />
          <ResultRow
            label="Y right (A–C side)"
            value={formatM(results.yRight)}
            pass={results.passRight}
          />
          <p className="mt-2 text-xs leading-5 text-slate-500">
            Y measured geodesically from the junction mouth to each handle.
            On curved roads, verify along the kerb line with the measure tool
            — Y should follow the nearer carriageway edge.
          </p>
        </div>

        {/* Sightline heights */}
        <div className={sectionCls}>
          <div className={headingCls}>Sightline heights</div>
          <HeightControl
            label="Driver eye height"
            value={params.eyeHeight}
            min={DRIVER_EYE_HEIGHT_RANGE_M[0]}
            max={DRIVER_EYE_HEIGHT_RANGE_M[1]}
            onChange={(v) => onUpdateParams({ eyeHeight: v })}
          />
          <HeightControl
            label="Object height"
            value={params.objectHeight}
            min={OBJECT_HEIGHT_RANGE_M[0]}
            max={OBJECT_HEIGHT_RANGE_M[1]}
            onChange={(v) => onUpdateParams({ objectHeight: v })}
          />
          <p className="mt-2 text-xs leading-5 text-slate-500">
            An obstruction matters if it intrudes into the splay between the
            object height ({params.objectHeight.toFixed(2)} m) and{" "}
            {OBJECT_HEIGHT_MAX_M.toFixed(1)} m above the carriageway, seen from
            the driver eye height ({params.eyeHeight.toFixed(2)} m). These drive
            the 3D driver's-eye view and the export summary.
          </p>
        </div>

        {/* Tools */}
        <div className={sectionCls}>
          <div className={headingCls}>Tools</div>
          <div className="flex gap-2">
            <button
              className={`${props.measuring ? btnPrimary : btnSecondary} flex-1`}
              onClick={props.onToggleMeasure}
            >
              📏 Measure {props.measuring ? "(on)" : ""}
            </button>
            <button
              className={`${btnSecondary} flex-1`}
              onClick={() =>
                props.onMapType(props.mapType === "hybrid" ? "roadmap" : "hybrid")
              }
            >
              {props.mapType === "hybrid" ? "🗺 Roadmap" : "🛰 Satellite"}
            </button>
          </div>
          {props.measuring && (
            <p className="mt-1.5 text-xs text-slate-400">
              {props.measureDist != null
                ? `Distance: ${props.measureDist.toFixed(2)} m`
                : "Click two points on the map."}
            </p>
          )}
          <button
            className={`${
              props.threeDOpen ? btnPrimary : btnSecondary
            } mt-2 w-full`}
            disabled={!props.canInspect}
            onClick={props.onInspect3D}
            title={
              props.canInspect
                ? "Automated line-of-sight test against Google 3D tiles, both legs"
                : "Draw a splay (origin + at least one Y point) first"
            }
          >
            🔎 3D sightline check
          </button>
          {props.canInspect && (
            <p className="mt-1.5 text-xs leading-4 text-slate-500">
              Samples the Google 3D-tile surface along both legs (eye height →
              object height) and colours each sightline{" "}
              <span className="text-green-400">green</span> (clear) /{" "}
              <span className="text-red-400">red</span> (obstructed), marking
              the worst obstruction. Also view from the driver’s seat — left /
              ahead / right. A desktop indicator — the tiles include trees and
              parked cars, so verify on site. Needs the Map Tiles API.
            </p>
          )}
        </div>

        {/* Save / export */}
        <div className={sectionCls}>
          <div className={headingCls}>Assessment</div>
          <input
            type="text"
            placeholder="Site name (e.g. A38 / Mill Lane junction)"
            className={inputCls}
            value={props.siteName}
            onChange={(e) => props.onSiteName(e.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button className={`${btnPrimary} flex-1`} onClick={props.onSave}>
              Save
            </button>
            <button className={btnSecondary} onClick={props.onSaveAsNew}>
              Save as new
            </button>
            <button
              className={`${btnSecondary} flex-1`}
              disabled={!props.canExport || props.exporting}
              onClick={props.onExport}
              title={
                props.canExport
                  ? "Download a PNG with the splay and a parameters summary"
                  : "Draw a complete splay first"
              }
            >
              {props.exporting ? "Exporting…" : "Export PNG"}
            </button>
          </div>
          <p className="mt-2 text-[11px] italic leading-4 text-amber-400/80">
            {EXPORT_DISCLAIMER}
          </p>
        </div>

        {/* Saved list */}
        <div className={sectionCls}>
          <div className={headingCls}>
            Saved assessments ({props.saved.length})
          </div>
          {props.saved.length === 0 && (
            <p className="text-xs text-slate-500">
              Nothing saved yet — stored locally in this browser.
            </p>
          )}
          <ul className="space-y-1.5">
            {props.saved.map((a) => (
              <li
                key={a.id}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${
                  a.id === props.currentId
                    ? "border-sky-600/60 bg-sky-600/10"
                    : "border-slate-800 bg-slate-800/50"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-200">
                    {a.name}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {new Date(a.updatedAt).toLocaleString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    · {STANDARD_LABELS[a.params.standard]} · Y{" "}
                    {a.params.yRequired.toFixed(0)} m
                    {a.designOverlay ? " · 📐 plan" : ""}
                  </div>
                </div>
                <button
                  className="rounded px-2 py-1 text-xs font-medium text-sky-400 hover:bg-slate-700"
                  onClick={() => props.onLoad(a.id)}
                >
                  Load
                </button>
                <button
                  className="rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-red-500/20 hover:text-red-400"
                  title="Delete"
                  onClick={() => props.onDelete(a.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Footer */}
        <div className="px-4 py-3.5 text-[11px] leading-5 text-slate-600">
          <p className="mb-2 italic text-amber-400/90">
            This tool is for preliminary analysis and is not an alternative to
            site visits. —{" "}
            <span className="font-semibold not-italic">Bilal Choudhury</span>
          </p>
          Obstruction envelope {params.objectHeight.toFixed(2)}–
          {OBJECT_HEIGHT_MAX_M.toFixed(1)} m above carriageway, eye height{" "}
          {params.eyeHeight.toFixed(2)} m. Standards values are provisional —
          verify against MfS Table 7.1 and DMRB CD 109 before relying on
          results.
        </div>
      </div>
    </div>
  );
}

/**
 * Superimpose a proposed design layout (site plan exported as PNG/JPG) on the
 * map, align it to the existing road, then draw the splay against the new
 * design lines. Placement = centre + real-world width + rotation + opacity.
 */
function DesignOverlaySection({
  design,
  designAdjust,
  measuring,
  measureDist,
  onToggleMeasure,
  onFile,
  onUpdate,
  onAdjust,
  onRemove,
}: {
  design: DesignOverlaySettings | null;
  designAdjust: boolean;
  measuring: boolean;
  measureDist: number | null;
  onToggleMeasure: () => void;
  onFile: (file: File) => void;
  onUpdate: (patch: Partial<DesignOverlaySettings>) => void;
  onAdjust: (v: boolean) => void;
  onRemove: () => void;
}) {
  const [trueLen, setTrueLen] = useState("");

  const pickFile = (label: string) => (
    <label className={`${btnSecondary} block w-full cursor-pointer text-center`}>
      {label}
      <input
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = ""; // allow re-selecting the same file
        }}
      />
    </label>
  );

  const trueLenNum = Number(trueLen);
  const canCalibrate =
    design != null &&
    measureDist != null &&
    measureDist > 0 &&
    Number.isFinite(trueLenNum) &&
    trueLenNum > 0;

  return (
    <div className={sectionCls}>
      <div className={headingCls}>Design layout overlay</div>
      {!design ? (
        <>
          {pickFile("📐 Superimpose design layout…")}
          <p className="mt-1.5 text-xs leading-4 text-slate-500">
            Overlay a proposed layout plan (PNG / JPG — export PDF or CAD sheets
            as an image first) on the map, align it to the existing road, then
            draw and check the splay against the new design lines.
          </p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div
              className="min-w-0 flex-1 truncate text-sm text-slate-200"
              title={design.imageName}
            >
              📐 {design.imageName}
            </div>
            <button
              className="rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-red-500/20 hover:text-red-400"
              title="Remove the design overlay"
              onClick={onRemove}
            >
              ✕
            </button>
          </div>

          <div className="mt-2 flex gap-2">
            <button
              className={`${designAdjust ? btnPrimary : btnSecondary} flex-1`}
              onClick={() => onAdjust(!designAdjust)}
              title="Show drag handles on the map: round = move, square corner = rotate & scale"
            >
              {designAdjust ? "✓ Adjusting…" : "Adjust on map"}
            </button>
            <button
              className={`${btnSecondary} flex-1`}
              onClick={() => onUpdate({ visible: !design.visible })}
            >
              {design.visible ? "Hide" : "Show"}
            </button>
          </div>

          <div className="mt-3 text-xs font-medium text-slate-400">
            Opacity — {Math.round(design.opacity * 100)}%
          </div>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={design.opacity}
            onChange={(e) => onUpdate({ opacity: Number(e.target.value) })}
            className="mt-1 w-full accent-sky-500"
          />

          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <div className="text-xs font-medium text-slate-400">
                Rotation (°)
              </div>
              <input
                type="number"
                step={0.5}
                className={`${inputCls} mt-1`}
                value={design.rotationDeg}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) {
                    onUpdate({ rotationDeg: ((v + 540) % 360) - 180 });
                  }
                }}
              />
            </div>
            <div>
              <div className="text-xs font-medium text-slate-400">
                Image width (m)
              </div>
              <input
                type="number"
                min={1}
                step={1}
                className={`${inputCls} mt-1`}
                value={design.widthM}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 1) onUpdate({ widthM: v });
                }}
              />
            </div>
          </div>

          {/* Scale calibration from a known plan dimension */}
          <div className="mt-3 rounded-md border border-slate-800 bg-slate-800/40 p-2">
            <div className="text-xs font-medium text-slate-400">
              Calibrate scale
            </div>
            <p className="mt-1 text-xs leading-4 text-slate-500">
              Measure a known length on the overlaid plan (its scale bar or a
              dimensioned line) with{" "}
              <button
                className="font-medium text-sky-400 hover:underline"
                onClick={onToggleMeasure}
              >
                📏 Measure{measuring ? " (on)" : ""}
              </button>
              , then enter the true length:
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="whitespace-nowrap text-xs text-slate-400">
                {measureDist != null
                  ? `${measureDist.toFixed(2)} m on map =`
                  : "measure first…"}
              </span>
              <input
                type="number"
                min={0.1}
                step={0.1}
                placeholder="true m"
                className={inputCls}
                value={trueLen}
                onChange={(e) => setTrueLen(e.target.value)}
                disabled={measureDist == null}
              />
              <button
                className={btnSecondary}
                disabled={!canCalibrate}
                onClick={() => {
                  if (!canCalibrate || !design || measureDist == null) return;
                  const factor = trueLenNum / measureDist;
                  onUpdate({
                    widthM: Math.round(design.widthM * factor * 10) / 10,
                  });
                  setTrueLen("");
                }}
              >
                Apply
              </button>
            </div>
          </div>

          <div className="mt-2">{pickFile("Replace image (keeps placement)…")}</div>
          <p className="mt-1.5 text-xs leading-4 text-slate-500">
            The plan sits <span className="text-slate-300">under</span> the
            splay overlay, and clicks pass straight through it — so draw the
            splay on the <span className="text-slate-300">new</span> kerb lines
            exactly as usual and the pass/fail check applies to the proposed
            layout.
          </p>
        </>
      )}
    </div>
  );
}

function HeightControl({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const set = (raw: number) => {
    if (Number.isFinite(raw)) onChange(clamp(Math.round(raw * 100) / 100, min, max));
  };
  return (
    <div className="mb-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">{label}</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={min}
            max={max}
            step={0.01}
            value={value}
            onChange={(e) => set(Number(e.target.value))}
            className="w-16 rounded-md border border-slate-700 bg-slate-800 px-1.5 py-1 text-right text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
          />
          <span className="text-xs text-slate-500">m</span>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        className="mt-1 w-full accent-sky-500"
      />
      <div className="flex justify-between text-[10px] text-slate-600">
        <span>{min.toFixed(2)} m</span>
        <span>{max.toFixed(2)} m</span>
      </div>
    </div>
  );
}

function ResultRow({
  label,
  value,
  pass,
}: {
  label: string;
  value: string;
  pass?: boolean | null;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-sm text-slate-100">{value}</span>
        {pass != null && (
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
              pass
                ? "bg-green-500/20 text-green-400"
                : "bg-red-500/20 text-red-400"
            }`}
          >
            {pass ? "PASS" : "FAIL"}
          </span>
        )}
      </span>
    </div>
  );
}
