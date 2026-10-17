"use client";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Notice, useAnnounce } from "@metafarm/ui";
import { FarmScene } from "@metafarm/map-scene/react";
import type { SceneDescription } from "@metafarm/map-scene/core";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useI18n } from "@/i18n/provider";

export default function ScenePage() {
  const { farmId } = useParams<{ farmId: string }>();
  const { m } = useI18n();
  return (
    <Suspense fallback={<p role="status">{m.scene.loading}</p>}>
      <RequireTenant>{(tenantId) => <Scene tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </Suspense>
  );
}

function Scene({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const announce = useAnnounce();
  const { m } = useI18n();
  // ?view=list forces the DOM alternative (also used by automated tests).
  const forceFallback = useSearchParams().get("view") === "list";
  const scene = useQuery(`scene:${farmId}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/scene", { params: { path: { tenantId, farmId } } })),
  );
  if (scene.loading) return <p role="status">{m.scene.loading}</p>;
  if (scene.error) return <Notice tone="error">{scene.error.message}</Notice>;
  const s = scene.data as unknown as SceneDescription;
  if (s.entities.length === 0) {
    return (
      <Notice>{m.scene.empty}</Notice>
    );
  }
  return <FarmScene scene={s} forceFallback={forceFallback} onStatus={(msg) => announce(msg)} labels={m.scene.labels} />;
}
