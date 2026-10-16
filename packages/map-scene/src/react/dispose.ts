import type { BufferGeometry, Material, Object3D, Texture } from "three";

/**
 * Releases GPU resources held by an object tree. React Three Fiber disposes
 * objects it created from JSX on unmount, but geometries, materials and
 * textures created imperatively (useMemo, loaders) must be disposed by us.
 */
export function disposeObject(root: Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) disposeMaterial(m);
  });
}

export function disposeMaterial(m: Material): void {
  for (const value of Object.values(m)) {
    if (value && typeof value === "object" && (value as Texture).isTexture) (value as Texture).dispose();
  }
  m.dispose();
}
