import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { QualityPreset } from "../core/quality";
import { capDevicePixelRatio, thin } from "../core/quality";
import type { SceneDescription, SceneEntity } from "../core/scene-builder";
import { InstancedPlants } from "./InstancedPlants";

export interface SceneCanvasProps {
  scene: SceneDescription;
  preset: QualityPreset;
  reducedMotion: boolean;
  selectedId?: string;
  onSelect?: (id: string) => void;
  onContextLost: () => void;
  /** Called after the first frame renders; used by tests and status announcements. */
  onReady?: () => void;
}

/**
 * The WebGL canvas. Loaded lazily (React.lazy) so three.js never ships to
 * pages that do not show the scene, and never runs during server rendering.
 */
export default function SceneCanvas(props: SceneCanvasProps) {
  const dpr = capDevicePixelRatio(typeof window === "undefined" ? 1 : window.devicePixelRatio, props.preset);
  return (
    <Canvas
      dpr={dpr}
      shadows={props.preset.shadows}
      // Render on demand: no continuous 60 fps loop when nothing moves (battery, reduced motion).
      frameloop="demand"
      gl={{ antialias: props.preset.antialias, powerPreference: "default", preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false }}
      camera={{ position: [0, 60, 80], fov: 45, near: 0.5, far: 5_000 }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          props.onContextLost();
        });
        gl.domElement.setAttribute("aria-hidden", "true");
        props.onReady?.();
      }}
    >
      <SceneContents {...props} />
    </Canvas>
  );
}

function SceneContents({ scene, preset, reducedMotion, selectedId, onSelect }: SceneCanvasProps) {
  const groups = useMemo(() => {
    const visible = thin(scene.entities, preset.maxInstances);
    const byAsset = new Map<string, SceneEntity[]>();
    for (const e of visible) {
      const list = byAsset.get(e.assetId) ?? [];
      list.push(e);
      byAsset.set(e.assetId, list);
    }
    return [...byAsset.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [scene.entities, preset.maxInstances]);

  const extent = useMemo(() => {
    let r = 20;
    for (const ring of scene.boundaryLocal) for (const [x, z] of ring) r = Math.max(r, Math.abs(x), Math.abs(z));
    for (const e of scene.entities) r = Math.max(r, Math.abs(e.x), Math.abs(e.z));
    return r;
  }, [scene]);

  return (
    <>
      <color attach="background" args={["#dfe8e1"]} />
      <hemisphereLight args={["#ffffff", "#5b6b4a", 0.9]} />
      <directionalLight position={[extent, extent * 1.5, extent * 0.5]} intensity={1.2} castShadow={preset.shadows} />
      <mesh rotation-x={-Math.PI / 2} receiveShadow={preset.shadows}>
        <planeGeometry args={[extent * 3, extent * 3]} />
        <meshStandardMaterial color="#a9b98f" roughness={1} />
      </mesh>
      {scene.boundaryLocal.map((ring, i) => (
        <BoundaryLine key={i} ring={ring} />
      ))}
      {groups.map(([assetId, entities]) => (
        <InstancedPlants
          key={assetId}
          assetId={assetId}
          entities={entities}
          detail={preset.geometryDetail}
          castShadow={preset.shadows}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
      <Controls extent={extent} reducedMotion={reducedMotion} />
      <RendererHygiene />
    </>
  );
}

function BoundaryLine({ ring }: { ring: [number, number][] }) {
  const { geometry, material } = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(ring.flatMap(([x, z]) => [x, 0.05, z]), 3));
    return { geometry: g, material: new LineBasicMaterial({ color: "#2b4c7e" }) };
  }, [ring]);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  return <lineLoop args={[geometry, material]} />;
}

function Controls({ extent, reducedMotion }: { extent: number; reducedMotion: boolean }) {
  const { camera, gl, invalidate } = useThree();
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = !reducedMotion;
    controls.maxPolarAngle = Math.PI / 2.1;
    controls.minDistance = 5;
    controls.maxDistance = extent * 6;
    controls.addEventListener("change", invalidate);
    return () => {
      controls.removeEventListener("change", invalidate);
      controls.dispose();
    };
  }, [camera, gl, extent, reducedMotion, invalidate]);
  return null;
}

/** Frees renderer-level caches when the canvas unmounts. */
function RendererHygiene() {
  const gl = useThree((s) => s.gl);
  useEffect(
    () => () => {
      gl.renderLists.dispose();
    },
    [gl],
  );
  return null;
}
