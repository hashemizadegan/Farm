"use client";
import { useId, useRef, useState, type ChangeEvent } from "react";
import { useAnnounce } from "@metafarm/ui";
import type { Schemas } from "@/lib/api";
import { ACCEPT, MAX_UPLOAD_BYTES, uploadFile, type UploadPurpose } from "@/lib/upload";
import { useI18n } from "@/i18n/provider";

type Item = { key: string; name: string; state: "uploading" | "done" | "error"; message?: string };

const TYPE_NAMES: Record<string, string> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WebP",
  "application/pdf": "PDF",
  "application/geo+json": "GeoJSON",
  "model/gltf-binary": "GLB",
};

/**
 * File picker that uploads each chosen file (ticket → bytes → confirm) and
 * reports progress per file, both visibly and to screen readers. Files are
 * checked against the purpose's type list and size limit before upload.
 */
export function FileUploader(props: {
  tenantId: string;
  farmId: string;
  purpose: UploadPurpose;
  label: string;
  hint?: string;
  multiple?: boolean;
  onUploaded?: (media: Schemas["MediaObject"][]) => void;
}) {
  const { tenantId, farmId, purpose, label, hint, multiple = true, onUploaded } = props;
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const announce = useAnnounce();
  const { m, fmt } = useI18n();
  const t = m.upload;
  const [items, setItems] = useState<Item[]>([]);
  const busy = items.some((i) => i.state === "uploading");
  const types = ACCEPT[purpose];
  const typeText = types.map((t) => TYPE_NAMES[t] ?? t).join(", ");

  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    const batch: Item[] = files.map((f, n) => ({ key: `${Date.now()}-${n}`, name: f.name, state: "uploading" }));
    setItems((prev) => [...batch, ...prev].slice(0, 20));
    announce(t.uploadingN(files.length));

    const done: Schemas["MediaObject"][] = [];
    let failed = 0;
    // Sequential: keeps memory bounded and gives a clear order of results.
    for (const [n, file] of files.entries()) {
      const key = batch[n]!.key;
      try {
        done.push(await uploadFile({ tenantId, file, purpose, farmId, text: { ...t, size: fmt.size } }));
        setItems((prev) => prev.map((i) => (i.key === key ? { ...i, state: "done" } : i)));
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : t.failedGeneric;
        setItems((prev) => prev.map((i) => (i.key === key ? { ...i, state: "error", message } : i)));
      }
    }
    announce(
      failed === 0 ? t.uploadedN(done.length) : t.partial(done.length, failed),
    );
    if (done.length > 0) onUploaded?.(done);
  }

  return (
    <div className="uploader">
      <label htmlFor={id} className="uploader__label">
        {label}
      </label>
      <p id={`${id}-hint`} className="mf-hint">
        {hint ? `${hint} ` : ""}
        {t.accepted(typeText, fmt.size(MAX_UPLOAD_BYTES))}
      </p>
      <input
        ref={input}
        id={id}
        type="file"
        accept={types.join(",")}
        multiple={multiple}
        disabled={busy}
        aria-describedby={`${id}-hint`}
        onChange={onChange}
        className="uploader__input"
      />
      {items.length > 0 && (
        <ul className="uploader__status" aria-label={t.results}>
          {items.map((i) => (
            <li key={i.key} data-state={i.state}>
              <span className="uploader__name">{i.name}</span>
              <span className="uploader__state">
                {i.state === "uploading" ? t.uploading : i.state === "done" ? t.uploaded : t.failed(i.message ?? "")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
