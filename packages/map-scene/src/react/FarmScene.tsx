import { Component, Suspense, lazy, useEffect, useId, useState, type ReactNode } from "react";
import { QUALITY_PRESETS, autoQuality, type QualityLevel } from "../core/quality";
import type { SceneDescription } from "../core/scene-builder";
import { detectWebGL, type WebGLSupport } from "../core/webgl";
import { EN_SCENE_LABELS, type SceneLabels } from "./labels";
import { SceneEntityList } from "./SceneEntityList";

// Lazy: three.js and the renderer load only when a 3D view is actually shown.
const SceneCanvas = lazy(() => import("./SceneCanvas"));

const QUALITY_KEY = "metafarm.scene.quality";

export interface FarmSceneProps {
  scene: SceneDescription;
  /** Force the DOM view (used by tests and by users who prefer it). */
  forceFallback?: boolean;
  onStatus?: (message: string) => void;
  /** Translated text; English by default. */
  labels?: SceneLabels;
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
export function FarmScene({ scene, forceFallback, onStatus, labels = EN_SCENE_LABELS }: FarmSceneProps) {
  const L = labels;
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
    setSupport(forceFallback ? { supported: false, reason: L.disabledReason } : detectWebGL());
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
  }, [forceFallback, L.disabledReason]);

  const changeQuality = (q: QualityLevel) => {
    setQuality(q);
    try {
      window.localStorage.setItem(QUALITY_KEY, q);
    } catch {
      /* ignore */
    }
    announce(L.qualitySet(L.qualityLevels[q]));
  };

  const select = (id: string) => {
    setSelectedId(id);
    const e = scene.entities.find((x) => x.id === id);
    announce(L.selectedAnnounce(e?.label ?? id));
  };

  const canRender3D = support?.supported === true && !failure;
  const showCanvas = canRender3D && mode === "3d";
  const selected = scene.entities.find((e) => e.id === selectedId);

  return (
    <section className="mf-scene" aria-labelledby={headingId}>
      <h2 id={headingId}>{L.heading}</h2>
      <p className="mf-notice" role="note">
        <strong>{L.illustrativeOnly}</strong> {L.disclaimer ?? scene.disclaimer}
      </p>

      <div className="mf-toolbar" role="group" aria-label={L.controls}>
        <fieldset disabled={!canRender3D}>
          <legend className="mf-visually-hidden">{L.view}</legend>
          <button type="button" aria-pressed={mode === "3d"} onClick={() => setMode("3d")}>
            {L.view3d}
          </button>
          <button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>
            {L.viewList}
          </button>
        </fieldset>
        <label htmlFor={qualityId}>{L.quality}</label>
        <select id={qualityId} value={quality} onChange={(e) => changeQuality(e.target.value as QualityLevel)} disabled={!canRender3D}>
          <option value="low">{L.qualityLevels.low}</option>
          <option value="medium">{L.qualityLevels.medium}</option>
          <option value="high">{L.qualityLevels.high}</option>
        </select>
      </div>

      {support && !canRender3D && (
        <p className="mf-notice" role="status" data-testid="webgl-fallback">
          {L.unavailable(failure ?? (support.supported ? "" : support.reason))}
        </p>
      )}

      {showCanvas && (
        <div className="mf-canvas" data-testid="scene-canvas" data-quality={quality}>
          <SceneErrorBoundary onError={(m) => setFailure(m)}>
            <Suspense fallback={<p role="status">{L.loading}</p>}>
              <SceneCanvas
                scene={scene}
                preset={QUALITY_PRESETS[quality]}
                reducedMotion={reducedMotion}
                selectedId={selectedId}
                onSelect={select}
                onContextLost={() => {
                  setFailure(L.contextLost);
                  announce(L.contextLostAnnounce);
                }}
                onReady={() => announce(L.ready(scene.entities.length))}
              />
            </Suspense>
          </SceneErrorBoundary>
          <p className="mf-muted">{L.hint}</p>
        </div>
      )}

      {selected && (
        <div className="mf-selection" aria-live="polite">
          <h3>{L.selectedHeading}</h3>
          <dl>
            <dt>{L.name}</dt>
            <dd>{selected.label ?? selected.id}</dd>
            <dt>{L.position}</dt>
            <dd>
              {L.positionValue(selected.x.toFixed(1), (-selected.z).toFixed(1))}
            </dd>
            <dt>{L.provenance}</dt>
            <dd>{L.provenanceName?.(selected.provenance) ?? selected.provenance}</dd>
          </dl>
        </div>
      )}

      {!showCanvas && <SceneEntityList scene={scene} selectedId={selectedId} onSelect={select} labels={L} />}

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
