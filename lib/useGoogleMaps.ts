"use client";

/**
 * Loads the Google Maps JS API once (singleton) and reports readiness.
 * Requires NEXT_PUBLIC_GOOGLE_MAPS_API_KEY in .env.local.
 */

import { Loader } from "@googlemaps/js-api-loader";
import { useEffect, useState } from "react";

export type MapsLoadState =
  | { status: "missing-key" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

let loaderPromise: Promise<void> | null = null;

function loadMaps(apiKey: string): Promise<void> {
  if (!loaderPromise) {
    const loader = new Loader({
      apiKey,
      version: "weekly",
      libraries: ["geometry", "places", "marker"],
    });
    loaderPromise = Promise.all([
      loader.importLibrary("maps"),
      loader.importLibrary("geometry"),
      loader.importLibrary("places"),
      loader.importLibrary("marker"),
    ]).then(() => undefined);
  }
  return loaderPromise;
}

export function useGoogleMaps(): MapsLoadState {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [state, setState] = useState<MapsLoadState>(
    apiKey ? { status: "loading" } : { status: "missing-key" }
  );

  useEffect(() => {
    if (!apiKey) return;
    let cancelled = false;
    loadMaps(apiKey)
      .then(() => {
        if (!cancelled) setState({ status: "ready" });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  return state;
}
