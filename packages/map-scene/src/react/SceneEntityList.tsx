import { useId, useMemo, useState } from "react";
import type { SceneDescription } from "../core/scene-builder";
import { EN_SCENE_LABELS, type SceneLabels } from "./labels";

interface Props {
  scene: SceneDescription;
  selectedId?: string;
  onSelect: (id: string) => void;
  pageSize?: number;
  labels?: SceneLabels;
}

/**
 * Keyboard- and screen-reader-accessible equivalent of the 3D scene.
 * Every action available in 3D (inspect and select an element) is available
 * here with standard controls. Paginated so very large plans stay usable.
 */
export function SceneEntityList({ scene, selectedId, onSelect, pageSize = 50, labels = EN_SCENE_LABELS }: Props) {
  const L = labels;
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filterId = useId();
  const captionId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? scene.entities.filter((e) => (e.label ?? e.id).toLowerCase().includes(q)) : scene.entities;
  }, [scene.entities, query]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages - 1);
  const rows = filtered.slice(current * pageSize, current * pageSize + pageSize);

  return (
    <section aria-labelledby={captionId} className="mf-scene-list">
      <h3 id={captionId}>{L.listHeading(filtered.length)}</h3>
      <p className="mf-muted">{L.disclaimer ?? scene.disclaimer}</p>
      <label htmlFor={filterId}>{L.filter}</label>
      <input
        id={filterId}
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPage(0);
        }}
      />
      <table>
        <caption className="mf-visually-hidden">
          {L.caption(current + 1, pages)}
        </caption>
        <thead>
          <tr>
            <th scope="col">{L.element}</th>
            <th scope="col">{L.east}</th>
            <th scope="col">{L.north}</th>
            <th scope="col">{L.provenance}</th>
            <th scope="col">
              <span className="mf-visually-hidden">{L.action}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const selected = e.id === selectedId;
            return (
              <tr key={e.id} aria-selected={selected} data-entity-id={e.id}>
                <th scope="row">{e.label ?? e.id}</th>
                <td>{e.x.toFixed(1)}</td>
                <td>{(-e.z).toFixed(1)}</td>
                <td>{L.provenanceName?.(e.provenance) ?? e.provenance}</td>
                <td>
                  <button type="button" aria-pressed={selected} onClick={() => onSelect(e.id)}>
                    {selected ? L.selected : L.select}
                    <span className="mf-visually-hidden"> {e.label ?? e.id}</span>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <nav aria-label={L.pages} className="mf-pager">
        <button type="button" onClick={() => setPage(current - 1)} disabled={current === 0}>
          {L.previous}
        </button>
        <span aria-live="polite">
          {L.pageOf(current + 1, pages)}
        </span>
        <button type="button" onClick={() => setPage(current + 1)} disabled={current >= pages - 1}>
          {L.next}
        </button>
      </nav>
    </section>
  );
}
