"use client";
import { useEffect, useState } from "react";
import { EmptyState, Notice } from "@metafarm/ui";
import { api, unwrap, useQuery } from "@/lib/api";
import { describeSize, fileObjectUrl, type UploadPurpose } from "@/lib/upload";

type Media = { id: string; filename: string; contentType: string; byteSize: number; createdAt: string; uploadedBy?: string | null };

/** Confirmed files for a farm and purpose: photos as a gallery, other files as a list. */
export function FileList(props: { tenantId: string; farmId: string; purpose: UploadPurpose; reloadKey?: number; emptyTitle: string; emptyText?: string }) {
  const { tenantId, farmId, purpose, reloadKey = 0, emptyTitle, emptyText } = props;
  const list = useQuery(`media:${farmId}:${purpose}:${reloadKey}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/media", { params: { path: { tenantId, farmId }, query: { purpose } } })),
  );

  if (list.loading && !list.data) return <p role="status">Loading files…</p>;
  if (list.error) return <Notice tone="error" title="Could not load files.">{list.error.message}</Notice>;
  const items = (list.data?.items ?? []) as Media[];
  if (items.length === 0) return <EmptyState title={emptyTitle}>{emptyText}</EmptyState>;

  const photos = items.every((m) => m.contentType.startsWith("image/"));
  return photos ? (
    <ul className="gallery">
      {items.map((m) => (
        <li key={m.id}>
          <Photo tenantId={tenantId} media={m} />
        </li>
      ))}
    </ul>
  ) : (
    <ul className="files">
      {items.map((m) => (
        <li key={m.id}>
          <span>
            <strong>{m.filename}</strong>
            <br />
            <span className="mf-hint">
              {describeSize(m.byteSize)} · {byline(m)}
            </span>
          </span>
          <DownloadButton tenantId={tenantId} media={m} />
        </li>
      ))}
    </ul>
  );
}

function byline(m: Media) {
  const when = new Date(m.createdAt).toLocaleString();
  return m.uploadedBy ? `uploaded by ${m.uploadedBy}, ${when}` : `uploaded ${when}`;
}

/** Loads the image with the user's token (files are private) and frees it on unmount. */
function Photo({ tenantId, media }: { tenantId: string; media: Media }) {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | undefined;
    let cancelled = false;
    fileObjectUrl(tenantId, media.id)
      .then((u) => (cancelled ? URL.revokeObjectURL(u) : setSrc((url = u))))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [tenantId, media.id]);

  return (
    <figure>
      {src ? (
        <a href={src} target="_blank" rel="noopener noreferrer">
          <img src={src} alt={media.filename} loading="lazy" />
        </a>
      ) : (
        <div className="gallery__placeholder" role="img" aria-label={failed ? `Could not load ${media.filename}` : `Loading ${media.filename}`} />
      )}
      <figcaption>
        {media.filename}
        <br />
        <span className="mf-hint">{byline(media)}</span>
      </figcaption>
    </figure>
  );
}

function DownloadButton({ tenantId, media }: { tenantId: string; media: Media }) {
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  async function download() {
    setState("busy");
    try {
      const url = await fileObjectUrl(tenantId, media.id);
      const a = document.createElement("a");
      a.href = url;
      a.download = media.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setState("idle");
    } catch {
      setState("error");
    }
  }
  return (
    <button type="button" className="mf-button mf-button--secondary" onClick={download} disabled={state === "busy"}>
      {state === "busy" ? "Preparing…" : state === "error" ? "Retry download" : "Download"}
      <span className="mf-visually-hidden"> {media.filename}</span>
    </button>
  );
}
