"use client";
import { useEffect, useRef, useState } from "react";
import type { BoundaryGeometry } from "@metafarm/domain/geometry";
import { createMapLibreAdapter, type MapHandle } from "@metafarm/map-scene/map";

interface Props {
  boundary?: BoundaryGeometry | null;
  center?: [number, number];
  /** When set, clicks on the map add vertices; the parent owns the draft. */
  draft?: [number, number][];
  onAddVertex?: (lonLat: [number, number]) => void;
  label: string;
}

const adapter = createMapLibreAdapter({
  styleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL,
  attribution: process.env.NEXT_PUBLIC_MAP_ATTRIBUTION,
  // Copied into public/ by scripts/copy-maplibre-worker.mjs before dev/build.
  workerUrl: "/maplibre-gl-worker.mjs",
});

/**
 * Map view. The map is a visual aid only: every action (entering a point,
 * drawing a boundary, reviewing vertices) has a text/keyboard equivalent on
 * the same page, so the map never blocks a task (WCAG 2.1.1, 2.5.7).
 */
export function BoundaryMap({ boundary, center, draft, onAddVertex, label }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<MapHandle | null>(null);
  const [failed, setFailed] = useState<string>();
  const onAdd = useRef(onAddVertex);
  onAdd.current = onAddVertex;

  useEffect(() => {
    let destroyed = false;
    let off: (() => void) | undefined;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    adapter
      .mount(container.current!, { center: center ?? [0, 20], zoom: center ? 15 : 1.5, reducedMotion })
      .then((h) => {
        if (destroyed) return h.destroy();
        handle.current = h;
        off = h.onClick(({ lon, lat }) => onAdd.current?.([round7(lon), round7(lat)]));
      })
      .catch((e: Error) => setFailed(e.message));
    return () => {
      destroyed = true;
      off?.();
      handle.current?.destroy();
      handle.current = null;
    };
    // Mount once; later prop changes are pushed through the handle below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    h.setBoundary(boundary ?? null);
    if (boundary) {
      const coords = (boundary.type === "Polygon" ? [boundary.coordinates] : boundary.coordinates).flatMap((p) => p.flatMap((r) => r));
      const xs = coords.map((c) => c[0]);
      const ys = coords.map((c) => c[1]);
      h.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
  }, [boundary]);

  useEffect(() => handle.current?.setDraft(draft ?? []), [draft]);
  useEffect(() => {
    if (center) handle.current?.flyTo(center[0], center[1]);
  }, [center]);

  return (
    <figure style={{ margin: 0 }}>
      {failed ? (
        <p className="mf-notice" role="status">
          The map could not be displayed ({failed}). You can still enter coordinates in the form.
        </p>
      ) : (
        <div ref={container} className="mf-map" role="region" aria-label={label} data-testid="boundary-map" />
      )}
      <figcaption className="mf-muted">
        {onAddVertex ? "Click the map to add boundary points, or type coordinates below. " : ""}
        Boundaries shown here are as submitted by users unless marked independently verified.
      </figcaption>
    </figure>
  );
}

function round7(n: number) {
  return Math.round(n * 1e7) / 1e7;
}
