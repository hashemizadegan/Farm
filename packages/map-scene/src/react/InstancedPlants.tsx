import { useLayoutEffect, useMemo, useRef } from "react";
import { Color, ConeGeometry, type InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from "three";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import type { SceneEntity } from "../core/scene-builder";
import { disposeMaterial } from "./dispose";

interface Props {
  assetId: string;
  entities: SceneEntity[];
  detail: number;
  castShadow: boolean;
  selectedId?: string;
  onSelect?: (id: string) => void;
}

const BASE = new Color("#4f8a3a");
const SELECTED = new Color("#f2c14e");

/**
 * One InstancedMesh per asset type: thousands of plants cost one draw call.
 * Instance index → entity id mapping is kept so picking returns stable ids.
 */
export function InstancedPlants({ assetId, entities, detail, castShadow, selectedId, onSelect }: Props) {
  const ref = useRef<InstancedMesh>(null);
  // frameloop="demand": imperative instance updates must request a frame explicitly.
  const invalidate = useThree((s) => s.invalidate);
  const geometry = useMemo(() => {
    const g = new ConeGeometry(0.35, 1, Math.max(3, detail));
    g.translate(0, 0.5, 0);
    return g;
  }, [detail]);
  const material = useMemo(() => new MeshStandardMaterial({ color: BASE, roughness: 0.9 }), []);

  // Imperatively created resources must be released when they change or unmount.
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  useLayoutEffect(() => () => disposeMaterial(material), [material]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    entities.forEach((e, i) => {
      q.setFromAxisAngle(up, e.rotation);
      m.compose(new Vector3(e.x, 0, e.z), q, new Vector3(e.scale, e.scale, e.scale));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, e.id === selectedId ? SELECTED : BASE);
    });
    mesh.count = entities.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [entities, selectedId, invalidate]);

  const handleClick = (ev: ThreeEvent<MouseEvent>) => {
    if (ev.instanceId === undefined) return;
    ev.stopPropagation();
    const e = entities[ev.instanceId];
    if (e) onSelect?.(e.id);
  };

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, entities.length]}
      castShadow={castShadow}
      receiveShadow={false}
      onClick={handleClick}
      name={`plants:${assetId}`}
    />
  );
}
