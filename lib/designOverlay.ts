"use client";

/**
 * Design-layout overlay: renders an uploaded plan image on the map at a
 * geographic centre / real-world width / rotation. The image lives in the
 * `mapPane` (the lowest overlay pane) so splay polygons, markers and map
 * clicks all stay on top — the engineer clicks the new kerb lines straight
 * through the plan. Pure Maps-API plumbing; all state lives in SplayCheckApp.
 */

import type { DesignOverlaySettings } from "./types";

export interface DesignOverlayHandle {
  /** Apply new settings (position, width, rotation, opacity, image). */
  update(settings: DesignOverlaySettings): void;
  /** Aspect ratio (height / width) of the loaded image, null while loading. */
  getAspect(): number | null;
  /** Temporarily hide (e.g. during PNG capture) without touching settings. */
  setHidden(hidden: boolean): void;
  remove(): void;
}

export function createDesignOverlay(
  map: google.maps.Map,
  initial: DesignOverlaySettings,
  onAspect?: (aspect: number) => void
): DesignOverlayHandle {
  let settings = initial;
  let aspect: number | null = null;
  let hidden = false;
  let img: HTMLImageElement | null = null;
  let loadToken = 0;

  // Probe the data URL off-DOM so we know the aspect ratio before first draw.
  const loadAspect = (src: string) => {
    const token = ++loadToken;
    const probe = new Image();
    probe.onload = () => {
      if (token !== loadToken || !probe.naturalWidth) return;
      aspect = probe.naturalHeight / probe.naturalWidth;
      view.draw();
      if (aspect != null) onAspect?.(aspect);
    };
    probe.src = src;
  };

  class DesignOverlayView extends google.maps.OverlayView {
    onAdd() {
      img = document.createElement("img");
      img.src = settings.imageDataUrl;
      img.alt = "";
      img.style.position = "absolute";
      img.style.display = "none";
      img.style.pointerEvents = "none"; // clicks pass through to the map
      img.style.userSelect = "none";
      img.style.maxWidth = "none"; // beat any global img { max-width } reset
      this.getPanes()?.mapPane.appendChild(img);
      this.draw();
    }

    draw() {
      const proj = this.getProjection();
      if (!img || !proj) return;
      if (aspect == null || !settings.visible || hidden) {
        img.style.display = "none";
        return;
      }
      // Pixel width = projected distance between the image's west and east
      // edge midpoints (pre-rotation); rotation is applied purely in CSS.
      const centre = new google.maps.LatLng(settings.center);
      const half = settings.widthM / 2;
      const west = google.maps.geometry.spherical.computeOffset(centre, half, 270);
      const east = google.maps.geometry.spherical.computeOffset(centre, half, 90);
      const c = proj.fromLatLngToDivPixel(centre);
      const w = proj.fromLatLngToDivPixel(west);
      const e = proj.fromLatLngToDivPixel(east);
      if (!c || !w || !e) {
        img.style.display = "none";
        return;
      }
      const pxW = Math.hypot(e.x - w.x, e.y - w.y);
      if (!(pxW > 0)) {
        img.style.display = "none";
        return;
      }
      img.style.display = "";
      img.style.width = `${pxW}px`;
      img.style.height = `${pxW * aspect}px`;
      img.style.left = `${c.x}px`;
      img.style.top = `${c.y}px`;
      img.style.opacity = String(settings.opacity);
      img.style.transform = `translate(-50%, -50%) rotate(${settings.rotationDeg}deg)`;
    }

    onRemove() {
      img?.remove();
      img = null;
    }
  }

  const view = new DesignOverlayView();
  view.setMap(map);
  loadAspect(initial.imageDataUrl);

  return {
    update(next) {
      const srcChanged = next.imageDataUrl !== settings.imageDataUrl;
      settings = next;
      if (srcChanged) {
        aspect = null;
        if (img) img.src = next.imageDataUrl;
        loadAspect(next.imageDataUrl);
      }
      view.draw();
    },
    getAspect: () => aspect,
    setHidden(h) {
      hidden = h;
      view.draw();
    },
    remove() {
      loadToken++; // cancel any in-flight aspect probe
      view.setMap(null);
    },
  };
}
