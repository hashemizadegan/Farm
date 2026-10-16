import { useId, useMemo, useState } from "react";
import type { SceneDescription } from "../core/scene-builder";

interface Props {
  scene: SceneDescription;
  selectedId?: string;
  onSelect: (id: string) => void;
  pageSize?: number;
}

/**
 * Keyboard- and screen-reader-accessible equivalent of the 3D scene.
 * Every action available in 3D (inspect and select an element) is available
 * here with standard controls. Paginated so very large plans stay usable.
 */
export function SceneEntityList({ scene, selectedId, onSelect, pageSize = 50 }: Props) {
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
      <h3 id={captionId}>Scene elements ({filtered.length})</h3>
      <p className="mf-muted">{scene.disclaimer}</p>
      <label htmlFor={filterId}>Filter elements</label>
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
          Scene elements, page {current + 1} of {pages}. Positions are metres from the farm origin.
        </caption>
        <thead>
          <tr>
            <th scope="col">Element</th>
            <th scope="col">East (m)</th>
            <th scope="col">North (m)</th>
            <th scope="col">Provenance</th>
            <th scope="col">
              <span className="mf-visually-hidden">Action</span>
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
                <td>{e.provenance}</td>
                <td>
                  <button type="button" aria-pressed={selected} onClick={() => onSelect(e.id)}>
                    {selected ? "Selected" : "Select"}
                    <span className="mf-visually-hidden"> {e.label ?? e.id}</span>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <nav aria-label="Scene element pages" className="mf-pager">
        <button type="button" onClick={() => setPage(current - 1)} disabled={current === 0}>
          Previous page
        </button>
        <span aria-live="polite">
          Page {current + 1} of {pages}
        </span>
        <button type="button" onClick={() => setPage(current + 1)} disabled={current >= pages - 1}>
          Next page
        </button>
      </nav>
    </section>
  );
}
