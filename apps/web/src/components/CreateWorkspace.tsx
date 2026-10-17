"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, ErrorSummary, TextField, useAnnounce } from "@metafarm/ui";
import { api, unwrap } from "@/lib/api";
import { useTenant } from "@/lib/tenant";

/**
 * Shown to a signed-in user who belongs to no workspace. Creating one makes
 * them its owner; they can invite others later. If the operator disabled
 * self-service, the API says so and the message is shown as-is.
 */
export function CreateWorkspace({ intro = true, redirectTo }: { intro?: boolean; redirectTo?: string } = {}) {
  const router = useRouter();
  const { reloadMe, setTenantId } = useTenant();
  const announce = useAnnounce();
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setErrors([{ field: "workspace-name", message: "Enter a name for your workspace." }]);
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-error-summary]")?.focus());
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const created = await unwrap(api.POST("/v1/me/workspaces", { body: { name: name.trim() } }));
      setTenantId(created.tenantId);
      announce(`Workspace ${created.name} created.`);
      reloadMe();
      if (redirectTo) router.push(redirectTo);
    } catch (err) {
      setErrors([{ message: err instanceof Error ? err.message : "Could not create the workspace." }]);
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-error-summary]")?.focus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="create-workspace-heading">
      <h2 id="create-workspace-heading" className={intro ? undefined : "mf-visually-hidden"}>
        Create your workspace
      </h2>
      {intro && (
        <p>
          Your account is not part of a workspace yet. A workspace holds your farm projects and the people you work with.
          You will be its owner. If someone invited you, open their invitation link instead.
        </p>
      )}
      <ErrorSummary errors={errors} />
      <form onSubmit={onSubmit} noValidate>
        <TextField
          id="workspace-name"
          label="Workspace name"
          hint="For example your organisation or farm name."
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          autoComplete="organization"
          required
          error={errors.find((x) => x.field === "workspace-name")?.message}
        />
        <Button type="submit" variant="primary" busy={busy}>
          {busy ? "Creating…" : "Create workspace"}
        </Button>
      </form>
    </section>
  );
}
