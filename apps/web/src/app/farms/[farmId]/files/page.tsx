"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import { FileList } from "@/components/FileList";
import { FileUploader } from "@/components/FileUploader";
import { RequireTenant } from "@/components/RequireTenant";
import { useCan } from "@/lib/can";
import { useI18n } from "@/i18n/provider";

export default function FilesPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const t = useI18n().m.files;
  return (
    <>
      <h1>{t.title}</h1>
      <p className="mf-hint">{t.intro}</p>
      <RequireTenant>{(tenantId) => <Files tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

function Files({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const can = useCan();
  const t = useI18n().m.files;
  const [photosKey, setPhotosKey] = useState(0);
  const [docsKey, setDocsKey] = useState(0);
  const canUpload = can("media:upload");

  return (
    <>
      <section className="card" aria-labelledby="photos-heading">
        <h2 id="photos-heading">{t.photosHeading}</h2>
        {canUpload && (
          <FileUploader
            tenantId={tenantId}
            farmId={farmId}
            purpose="observation-photo"
            label={t.addPhotos}
            hint={t.photosHint}
            onUploaded={() => setPhotosKey((k) => k + 1)}
          />
        )}
        <FileList tenantId={tenantId} farmId={farmId} purpose="observation-photo" reloadKey={photosKey} emptyTitle={t.noPhotos} />
      </section>

      <section className="card" aria-labelledby="docs-heading" style={{ marginTop: "1.5rem" }}>
        <h2 id="docs-heading">{t.docsHeading}</h2>
        {canUpload && (
          <FileUploader
            tenantId={tenantId}
            farmId={farmId}
            purpose="verification-evidence"
            label={t.addDocs}
            hint={t.docsHint}
            onUploaded={() => setDocsKey((k) => k + 1)}
          />
        )}
        <FileList tenantId={tenantId} farmId={farmId} purpose="verification-evidence" reloadKey={docsKey} emptyTitle={t.noDocs} />
      </section>
    </>
  );
}
