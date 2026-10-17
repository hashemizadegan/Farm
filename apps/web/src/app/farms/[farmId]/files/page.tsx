"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import { FileList } from "@/components/FileList";
import { FileUploader } from "@/components/FileUploader";
import { RequireTenant } from "@/components/RequireTenant";
import { useCan } from "@/lib/can";

export default function FilesPage() {
  const { farmId } = useParams<{ farmId: string }>();
  return (
    <>
      <h1>Files</h1>
      <p className="mf-hint">
        Photos and documents for this farm. Files are private to your workspace. Anything uploaded here is shown as
        user-supplied; it is not checked by the platform.
      </p>
      <RequireTenant>{(tenantId) => <Files tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

function Files({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const can = useCan();
  const [photosKey, setPhotosKey] = useState(0);
  const [docsKey, setDocsKey] = useState(0);
  const canUpload = can("media:upload");

  return (
    <>
      <section className="card" aria-labelledby="photos-heading">
        <h2 id="photos-heading">Field photos</h2>
        {canUpload && (
          <FileUploader
            tenantId={tenantId}
            farmId={farmId}
            purpose="observation-photo"
            label="Add photos"
            hint="Pictures of crops, soil or equipment."
            onUploaded={() => setPhotosKey((k) => k + 1)}
          />
        )}
        <FileList tenantId={tenantId} farmId={farmId} purpose="observation-photo" reloadKey={photosKey} emptyTitle="No photos yet" />
      </section>

      <section className="card" aria-labelledby="docs-heading" style={{ marginTop: "1.5rem" }}>
        <h2 id="docs-heading">Documents and evidence</h2>
        {canUpload && (
          <FileUploader
            tenantId={tenantId}
            farmId={farmId}
            purpose="verification-evidence"
            label="Add documents"
            hint="Survey documents, registry extracts or inspection reports. A verifier can attach one to a boundary on the Boundary page."
            onUploaded={() => setDocsKey((k) => k + 1)}
          />
        )}
        <FileList tenantId={tenantId} farmId={farmId} purpose="verification-evidence" reloadKey={docsKey} emptyTitle="No documents yet" />
      </section>
    </>
  );
}
