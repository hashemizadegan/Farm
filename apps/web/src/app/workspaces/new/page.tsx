"use client";
import { PageHeader } from "@metafarm/ui";
import { CreateWorkspace } from "@/components/CreateWorkspace";
import { useTenant } from "@/lib/tenant";
import Link from "next/link";

export default function NewWorkspacePage() {
  const { signedIn } = useTenant();
  return (
    <>
      <PageHeader title="New workspace" description="A separate space with its own farms and members. You will be its owner." />
      {signedIn ? (
        <CreateWorkspace intro={false} redirectTo="/farms" />
      ) : (
        <p>
          <Link href="/sign-in">Sign in</Link> to create a workspace.
        </p>
      )}
    </>
  );
}
