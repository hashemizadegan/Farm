import { Component, Suspense, lazy, useEffect, useId, useState, type ReactNode } from "react";
import { QUALITY_PRESETS, autoQuality, type QualityLevel } from "../core/quality";
import type { SceneDescription } from "../core/scene-builder";
import { detectWebGL, type WebGLSupport } from "../core/webgl";
import { SceneEntityList } from "./SceneEntityList";

// Lazy: three.js and the renderer load only when a 3D view is actually shown.
const SceneCanvas = lazy(() => import("./SceneCanvas"));

const QUALITY_KEY = "metafarm.scene.quality";

export interface FarmSceneProps {
  scene: SceneDescription;
  /** Force the DOM view (used by tests and by users who prefer it). */
  forceFallback?: boolean;
  onStatus?: (message: string) => void;
}

type ViewMode = "3d" | "list";

/**
 * Accessible 3D farm scene:
 *  - lazy-loads the WebGL renderer,
 *  - low/medium/high quality with a capped device pixel ratio,
 *  - falls back to the DOM view when WebGL is unavailable, fails, or the context is lost,
 *  - mirrors every 3D action in a keyboard-operable list,
 *  - honours prefers-reduced-motion.
 */
export function FarmScene({ scene, forceFallback, onStatus }: FarmSceneProps) {
  const [support, setSupport] = useState<WebGLSupport | null>(null);
  const [quality, setQuality] = useState<QualityLevel>("medium");
  const [mode, setMode] = useState<ViewMode>("3d");
  const [failure, setFailure] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [reducedMotion, setReducedMotion] = useState(false);
  const [status, setStatus] = useState("");
  const qualityId = useId();
  const headingId = useId();

  const announce = (m: string) => {
    setStatus(m);
    onStatus?.(m);
  };

  useEffect(() => {
    setSupport(forceFallback ? { supported: false, reason: "3D view disabled" } : detectWebGL());
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(QUALITY_KEY);
    } catch {
      /* storage unavailable */
    }
    const nav = navigator as Navigator & { deviceMemory?: number };
    setQuality(
      stored === "low" || stored === "medium" || stored === "high"
        ? stored
        : autoQuality({
            hardwareConcurrency: nav.hardwareConcurrency,
            deviceMemoryGb: nav.deviceMemory,
            coarsePointer: window.matchMedia?.("(pointer: coarse)").matches,
            prefersReducedData: window.matchMedia?.("(prefers-reduced-data: reduce)").matches,
          }),
    );
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    setReducedMotion(!!mq?.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, [forceFallback]);

  const changeQuality = (q: QualityLevel) => {
    setQuality(q);
    try {
      window.localStorage.setItem(QUALITY_KEY, q);
    } catch {
      /* ignore */
    }
    announce(`Rendering quality set to ${q}.`);
  };

  const select = (id: string) => {
    setSelectedId(id);
    const e = scene.entities.find((x) => x.id === id);
    announce(`Selected ${e?.label ?? id}.`);
  };

  const canRender3D = support?.supported === true && !failure;
  const showCanvas = canRender3D && mode === "3d";
  const selected = scene.entities.find((e) => e.id === selectedId);

  return (
    <section className="mf-scene" aria-labelledby={headingId}>
      <h2 id={headingId}>Farm scene</h2>
      <p className="mf-notice" role="note">
        <strong>Illustrative only.</strong> {scene.disclaimer}
      </p>

      <div className="mf-toolbar" role="group" aria-label="Scene controls">
        <fieldset disabled={!canRender3D}>
          <legend className="mf-visually-hidden">View</legend>
          <button type="button" aria-pressed={mode === "3d"} onClick={() => setMode("3d")}>
            3D view
          </button>
          <button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>
            List view
          </button>
        </fieldset>
        <label htmlFor={qualityId}>Quality</label>
        <select id={qualityId} value={quality} onChange={(e) => changeQuality(e.target.value as QualityLevel)} disabled={!canRender3D}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>

      {support && !canRender3D && (
        <p className="mf-notice" role="status" data-testid="webgl-fallback">
          The 3D view is not available on this device ({failure ?? (support.supported ? "" : support.reason)}). All scene
          information is shown in the list below.
        </p>
      )}

      {showCanvas && (
        <div className="mf-canvas" data-testid="scene-canvas" data-quality={quality}>
          <SceneErrorBoundary onError={(m) => setFailure(m)}>
            <Suspense fallback={<p role="status">Loading 3D view…</p>}>
              <SceneCanvas
                scene={scene}
                preset={QUALITY_PRESETS[quality]}
                reducedMotion={reducedMotion}
                selectedId={selectedId}
                onSelect={select}
                onContextLost={() => {
                  setFailure("the graphics context was lost");
                  announce("3D view stopped; showing the list view instead.");
                }}
                onReady={() => announce(`3D view ready with ${scene.entities.length} elements.`)}
              />
            </Suspense>
          </SceneErrorBoundary>
          <p className="mf-muted">Drag to orbit, scroll to zoom. Every element can also be selected from the list view.</p>
        </div>
      )}

      {selected && (
        <div className="mf-selection" aria-live="polite">
          <h3>Selected element</h3>
          <dl>
            <dt>Name</dt>
            <dd>{selected.label ?? selected.id}</dd>
            <dt>Position</dt>
            <dd>
              {selected.x.toFixed(1)} m east, {(-selected.z).toFixed(1)} m north of origin
            </dd>
            <dt>Provenance</dt>
            <dd>{selected.provenance}</dd>
          </dl>
        </div>
      )}

      {!showCanvas && <SceneEntityList scene={scene} selectedId={selectedId} onSelect={select} />}

      <div className="mf-visually-hidden" role="status" aria-live="polite" data-testid="scene-status">
        {status}
      </div>
    </section>
  );
}

class SceneErrorBoundary extends Component<{ onError: (m: string) => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(err: unknown) {
    this.props.onError(err instanceof Error ? err.message : "the 3D renderer failed");
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
